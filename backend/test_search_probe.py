import sqlite3
import unittest
from search_probe import setup, positions, search, choose_strategy


def add(db, domain, message, aliases, fields, generation=1, environment='production'):
    db.execute('INSERT INTO messages VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
               (domain, message, message, '2026-10-27T00:00:00', 'Fixture', 'sender@example.net',
                '[]', 'automated', environment, 'synthetic/manifest', generation, 1))
    db.executemany('INSERT INTO mailbox_entries VALUES (?,?,?,?,?,?,?)',
                   [(domain, alias, message, 'inbox', False, '2026-10-27T00:00:00', 1)
                    for alias in aliases])
    db.executemany('INSERT INTO search_positions VALUES (?,?,?,?,?,?,?)',
                   positions(domain, message, generation, fields))


class SearchProbeTest(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        setup(self.db)
        add(self.db, 'exampleorg', 'a', ['info', 'support'],
            {'subject': ['Café membership'], 'body': ['renew your membership today'],
             'recipient': ['info@example.org', 'support@example.org']})
        add(self.db, 'exampleorg', 'b', ['support'],
            {'subject': ['membership'], 'body': ['renew membership today']}, environment='staging')
        add(self.db, 'example', 'a', ['info'], {'body': ['renew your membership today']})

    def ids(self, *args, **kw):
        return [row[0] for row in search(self.db, *args, **kw)]

    def test_isolation_filters_and_unicode(self):
        self.assertEqual(self.ids('exampleorg', 'info', 'CAFE'), ['a'])
        self.assertEqual(self.ids('exampleorg', 'info', 'membership', environment='staging'), [])
        self.assertEqual(self.ids('exampleorg', 'support', 'membership', environment='staging'), ['b'])
        self.assertEqual(self.ids('example', 'support', 'membership'), [])
        self.assertEqual(self.ids('exampleorg', 'info', 'info@example.org', field='recipient'), ['a'])
        self.assertEqual(self.ids('exampleorg', 'info', 'cafe', field='body'), [])
        self.assertEqual(self.ids('exampleorg', 'info', '', source='manual'), [])
        self.db.execute('UPDATE mailbox_entries SET is_read = ? WHERE alias_id = ?', (True, 'info'))
        self.assertEqual(self.ids('exampleorg', 'info', '', unread=True), [])
        self.assertEqual(self.ids('exampleorg', 'support', '', unread=True), ['b', 'a'])

    def test_phrase_and_and_boundaries(self):
        self.assertEqual(self.ids('exampleorg', 'support', '"renew your membership" today'), ['a'])
        self.assertEqual(self.ids('exampleorg', 'support', '"renew membership"'), ['b'])
        self.assertEqual(self.ids('exampleorg', 'support', '"membership renew"'), [])
        self.assertEqual(self.ids('exampleorg', 'info', '"com support"'), [])
        self.assertEqual(self.ids('exampleorg', 'info', '"membership renew"'), [])

    def test_cursor_ties_and_bound_values(self):
        first = search(self.db, 'exampleorg', 'support', 'membership', limit=1)
        second = search(self.db, 'exampleorg', 'support', 'membership', before=first[0][::-1], limit=1)
        self.assertEqual([first[0][0], second[0][0]], ['b', 'a'])
        self.assertEqual(self.ids("exampleorg' OR 1=1 --", 'support', ''), [])

    def test_search_strategies_agree(self):
        for query in ('membership', 'cafe', 'missing', '"renew your membership"', 'info@example.org'):
            self.assertEqual(self.ids('exampleorg', 'support', query, strategy='term'),
                             self.ids('exampleorg', 'support', query, strategy='mailbox'))

    def test_bounded_strategy_choice_with_common_and_rare_terms(self):
        for i in range(70):
            add(self.db, 'exampleorg', f'common-{i:03}', ['support'],
                {'body': ['common phrase here ' + ('rareselector' if i == 1 else 'regular')]})
        self.assertEqual(choose_strategy(self.db.execute, 'exampleorg', 'common')['strategy'], 'aggregate')
        self.assertEqual(choose_strategy(self.db.execute, 'exampleorg', '"common phrase"')['strategy'], 'mailbox')
        self.assertEqual(choose_strategy(self.db.execute, 'exampleorg', 'common rareselector'),
                         {'strategy': 'term', 'anchor': 'rareselector'})
        for query in ('common', 'common rareselector', '"common phrase"', 'missing'):
            self.assertEqual(self.ids('exampleorg', 'support', query,
                                     **choose_strategy(self.db.execute, 'exampleorg', query)),
                             self.ids('exampleorg', 'support', query, strategy='mailbox'))
            self.assertEqual(self.ids('exampleorg', 'support', query, strategy='aggregate'),
                             self.ids('exampleorg', 'support', query, strategy='mailbox'))
            self.assertEqual(self.ids('exampleorg', 'support', query,
                                     **choose_strategy(self.db.execute, 'exampleorg', query)),
                             self.ids('exampleorg', 'support', query, strategy='mailbox'))

    def test_unpublished_generation_and_independent_delete(self):
        self.db.executemany('INSERT INTO search_positions VALUES (?,?,?,?,?,?,?)',
                            positions('exampleorg', 'a', 2, {'body': ['unpublished']}))
        self.assertEqual(self.ids('exampleorg', 'support', 'unpublished'), [])
        self.db.execute('DELETE FROM mailbox_entries WHERE domain_id=? AND alias_id=? AND message_id=?',
                        ('exampleorg', 'info', 'a'))
        self.assertEqual(self.ids('exampleorg', 'info', 'cafe'), [])
        self.assertEqual(self.ids('exampleorg', 'support', 'cafe'), ['a'])

    def test_repeated_words_long_tokens_and_query_limits(self):
        add(self.db, 'exampleorg', 'c', ['info'], {'body': ['go go ' + 'x' * 4000]})
        self.assertEqual(self.ids('exampleorg', 'info', '"go go"'), ['c'])
        with self.assertRaises(ValueError):
            self.ids('exampleorg', 'info', '"unbalanced')
        with self.assertRaises(ValueError):
            self.ids('exampleorg', 'info', 'word ' * 17)
        with self.assertRaises(ValueError):
            self.ids('exampleorg', 'info', '', field='body; DROP TABLE messages')


if __name__ == '__main__':
    unittest.main()

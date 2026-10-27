"""Portable search feasibility probe; SQLite results are NOT DSQL cost evidence.

Only uses Python's standard library. Bound values throughout. No AWS calls.
"""
import hashlib
import re
import unicodedata
from pathlib import Path


def words(text):
    text = ''.join(c for c in unicodedata.normalize('NFKD', text)
                   if unicodedata.category(c)[0] != 'M').lower()
    return re.findall(r'[^\W_]+', text, re.UNICODE)


def digest(word):
    return hashlib.sha256(word.encode()).hexdigest()


def positions(domain, message, generation, fields):
    for field, sections in fields.items():
        for section, text in enumerate(sections):
            for position, word in enumerate(words(text)):
                yield (domain, message, generation, field, section, position, digest(word))


def setup(db):
    # Syntax adaptation only, not an emulation of DSQL semantics/plans.
    ddl = Path(__file__).with_name('schema.sql').read_text()
    db.executescript(ddl.replace('CREATE UNIQUE INDEX ASYNC', 'CREATE UNIQUE INDEX')
                    .replace('CREATE INDEX ASYNC', 'CREATE INDEX'))


def search_sql(domain, alias, query='', *, field=None, folder=None,
               environment=None, source=None, unread=False, before=None, limit=50, strategy='term', anchor=None):
    if field not in (None, 'sender', 'recipient', 'subject', 'body'):
        raise ValueError('Unknown field')
    if not 1 <= limit <= 100:
        raise ValueError('Page size must be 1..100')
    if strategy not in ('term', 'mailbox', 'aggregate'):
        raise ValueError('Unknown search strategy')
    if len(query) > 1000 or len(words(query)) > 16 or query.count('"') % 2:
        raise ValueError('Use balanced quotes and at most 16 words / 1000 characters')
    if anchor is not None and anchor not in words(query):
        raise ValueError('Anchor must be a query word')
    clauses = ['e.domain_id = ?', 'e.alias_id = ?']
    args = [domain, alias]
    if words(query) and strategy == 'term':
        # Alternative to probing every retained mailbox entry for a rare word.
        # DSQL must measure this against ordered mailbox-first probing for common words.
        clauses.append('e.message_id IN (SELECT a.message_id FROM search_positions a '
                       'WHERE a.domain_id = ? AND a.token = ?)')
        args.extend([domain, digest(anchor or words(query)[0])])
    if folder:
        clauses.append('e.folder = ?')
        args.append(folder)
    if environment:
        clauses.append('m.environment = ?')
        args.append(environment)
    if source:
        clauses.append('m.source = ?')
        args.append(source)
    if unread:
        clauses.append('e.is_read = ?')
        args.append(False)
    if before:
        clauses.append('(e.received_at < ? OR (e.received_at = ? AND e.message_id < ?))')
        args.extend([before[0], before[0], before[1]])
    # Words are ANDed. Quoted runs additionally require same-field/section adjacency.
    runs = [words(part) for part in re.findall(r'"([^"]+)"', query)]
    runs += [[word] for word in words(re.sub(r'"[^"]*"', '', query))]
    if strategy == 'aggregate' and words(query):
        tokens = sorted({digest(word) for word in words(query)})
        condition = ['p.domain_id = e.domain_id', 'p.message_id = e.message_id',
                     'p.generation = m.search_generation',
                     'p.token IN (' + ','.join('?' for _ in tokens) + ')']
        args.extend(tokens)
        if field:
            condition.append('p.field = ?')
            args.append(field)
        clauses.append('EXISTS (SELECT 1 FROM search_positions p WHERE ' +
                       ' AND '.join(condition) +
                       ' GROUP BY p.domain_id,p.message_id,p.generation HAVING COUNT(DISTINCT p.token) = ?)')
        args.append(len(tokens))
        # The aggregate checks all individual words. Keep separate positional
        # checks only for multiword quoted phrases.
        runs = [run for run in runs if len(run) > 1]
    for run in filter(None, runs):
        condition = ['p.domain_id = e.domain_id', 'p.message_id = e.message_id',
                     'p.generation = m.search_generation', 'p.token = ?']
        args.append(digest(run[0]))
        if field:
            condition.append('p.field = ?')
            args.append(field)
        for offset, word in enumerate(run[1:], 1):
            condition.append('EXISTS (SELECT 1 FROM search_positions q WHERE '
                             'q.domain_id = p.domain_id AND q.message_id = p.message_id '
                             'AND q.generation = p.generation AND q.field = p.field '
                             'AND q.section = p.section AND q.position = p.position + ? '
                             'AND q.token = ?)')
            args.extend([offset, digest(word)])
        clauses.append('EXISTS (SELECT 1 FROM search_positions p WHERE ' +
                       ' AND '.join(condition) + ')')
    args.append(limit)
    # Folder browsing needs no message-table join; fetch display metadata for the
    # selected page separately. Joining all messages can defeat a cheap top page.
    join = (' JOIN messages m ON m.domain_id = e.domain_id AND m.message_id = e.message_id'
            if words(query) or environment or source else '')
    sql = ('SELECT e.message_id, e.received_at FROM mailbox_entries e' + join + ' WHERE ' +
           ' AND '.join(clauses) +
           ' ORDER BY e.received_at DESC, e.message_id DESC LIMIT ?')
    return sql, args


def search(db, *args, **kwargs):
    return db.execute(*search_sql(*args, **kwargs)).fetchall()


def choose_strategy(execute, domain, query, *, field=None):
    """Bounded cardinality hints; no counters, maintenance writes or full counts.

    execute accepts SQLite-style placeholders; a driver adapter binds them natively.
    Hints may include unpublished/other-alias postings, affecting speed, never results.
    """
    tokens = list(dict.fromkeys(words(query)))
    if len(tokens) > 16 or len(query) > 1000:
        raise ValueError('Query exceeds limits')
    for token in tokens:
        statement = 'SELECT message_id FROM search_positions WHERE domain_id = ? AND token = ?'
        args = [domain, digest(token)]
        if field:
            statement += ' AND field = ?'
            args.append(field)
        rows = execute(statement + ' LIMIT 65', args).fetchall()
        if len(rows) < 65:
            return {'strategy': 'term', 'anchor': token}
    return {'strategy': 'mailbox' if '"' in query or not tokens else 'aggregate'}

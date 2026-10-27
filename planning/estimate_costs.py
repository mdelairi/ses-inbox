"""Reproduce planning estimates with Decimal; no AWS calls or credentials required."""
import json
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

ROOT = Path(__file__).resolve().parent
data = json.loads((ROOT / 'cost_inputs.json').read_text())
rates = {key: Decimal(value) for key, value in data['rates'].items()}

def amount(value):
    return Decimal(str(value))

def money(value):
    return str(value.quantize(Decimal('0.01'), rounding=ROUND_HALF_UP))

results = []
for scenario in data['scenarios']:
    s = {key: amount(value) for key, value in scenario.items() if key != 'name'}
    components = {
        'Database compute': s['dsql_dpus'] * rates['dsql_dpu'],
        'Database storage and search index': s['db_gb'] * rates['dsql_gb_month'],
        'S3 storage and requests': s['s3_gb'] * rates['s3_gb_month'] + s['s3_puts'] * rates['s3_put'] + s['s3_gets'] * rates['s3_get'],
        'Lambda': s['lambda_invocations'] * (rates['lambda_request'] + s['lambda_gb'] * s['lambda_seconds'] * rates['lambda_gb_second']),
        'Email': s['outgoing_recipients'] * rates['ses_outbound_recipient'] + s['incoming'] * (rates['ses_inbound_message'] + s['inbound_chunks_per_message'] * rates['ses_inbound_chunk']) + s['outbound_attachment_gb'] * rates['ses_outbound_attachment_gb'],
        'Queues and publish requests': s['sqs_requests'] * rates['sqs_standard_request'] + s['sns_publishes'] * rates['sns_publish'],
        'Secrets': s['secrets'] * rates['secret_month'] + s['secret_api_calls'] * rates['secret_api'],
        'Logs and alarms': s['log_ingested_gb'] * rates['log_ingested_gb'] + s['log_stored_gb'] * rates['log_stored_gb_month'] + s['alarms'] * rates['alarm_month'],
        'Google social login via Cognito': s['cognito_maus'] * rates['cognito_lite_social_mau'],
        'CloudFront Free plan': Decimal('0'),
    }
    total = sum(components.values(), Decimal('0'))
    key_calls = s['optional_kms_calls'] * rates['kms_request']
    results.append({
        'scenario': scenario['name'],
        'incoming': scenario['incoming'],
        'outgoing_recipients': scenario['outgoing_recipients'],
        's3_physical_gb': scenario['s3_gb'],
        'dsql_budget_dpus': scenario['dsql_dpus'],
        'components_usd': {key: money(value) for key, value in components.items()},
        'modeled_total_usd': money(total),
        'with_one_dollar_contingency_usd': money(total + Decimal('1')),
        'optional_custom_sender_initial_key_usd': money(rates['optional_kms_initial_month'] + key_calls),
        'optional_custom_sender_mature_key_usd': money(rates['optional_kms_rotated_month'] + key_calls),
        'unrounded_total_usd': str(total),
    })

output = {
    'verified_on': data['verified_on'],
    'currency': data['currency'],
    'region': data['region'],
    'notes': data['notes'],
    'scenarios': results,
    's3_storage_only_usd_per_month': {str(gb): money(Decimal(gb) * rates['s3_gb_month']) for gb in [10, 100, 1000]},
    'additional_100000_dpus_usd': money(Decimal('100000') * rates['dsql_dpu']),
}
(ROOT / 'cost_estimate.json').write_text(json.dumps(output, indent=2) + '\n')
print(json.dumps(output, indent=2))

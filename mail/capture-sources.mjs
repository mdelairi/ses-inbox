// Deployment-owned trust map. Record bodies never select their own domain/environment.
// No producer permission is granted until its reviewed role is configured in infrastructure.
export const captureSources = {
  'website-production': { domain: 'example.com', environment: 'production', producer: 'website', accountId: '111111111111', configurationSet: 'example-website-production-contact', kinds: ['website_contact'], senderDomain: 'example.com' },
  'website-staging': { domain: 'example.com', environment: 'staging', producer: 'website', accountId: '222222222222', configurationSet: null, kinds: ['website_contact'], senderDomain: 'example.com' },
  'exampleorg-staging': { domain: 'example.org', environment: 'staging', producer: 'exampleorg', accountId: '222222222222', configurationSet: 'exampleorg-staging-invitations', kinds: ['member_invitation', 'course_invitation', 'course_assigned', 'due_reminder', 'overdue_reminder', 'weekly_digest', 'marking_waiting'], senders: ['no-reply@example.org'] },
  // Prepared for future ordinary sending; does not enable ExampleOrg production email.
  'exampleorg-production': { domain: 'example.org', environment: 'production', producer: 'exampleorg', accountId: '111111111111', configurationSet: null, kinds: ['member_invitation', 'course_invitation', 'course_assigned', 'due_reminder', 'overdue_reminder', 'weekly_digest', 'marking_waiting'], senders: ['no-reply@example.org'] },
};

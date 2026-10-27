let session;
async function readSession() {
  const result = await fetch('/auth/session', { cache: 'no-store', credentials: 'same-origin' });
  if (result.status === 401) { location.replace('/signin'); return; }
  if (!result.ok) throw new Error('Session unavailable');
  session = await result.json();
}
await readSession();
document.addEventListener('click', async event => {
  const button = event.target.closest?.('[data-action="stage-signout"]');
  if (!button) return;
  button.disabled = true;
  try {
    await readSession();
    const body = '{}', digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(body));
    const result = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json', 'x-inbox-csrf': session.csrf, 'x-amz-content-sha256': [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('') }, body });
    if (!result.ok) throw new Error('Sign out failed');
    location.replace('/signin');
  } catch { button.disabled = false; button.textContent = 'Retry sign out'; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void readSession().catch(() => {}); });
setInterval(() => { if (!document.hidden) void readSession().catch(() => {}); }, 60_000);

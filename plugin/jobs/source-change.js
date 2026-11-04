// Ignore callbacks from retired CD2 watches, including already queued deliveries.
export async function run() { return { skipped: true, reason: 'organize-success-only' } }

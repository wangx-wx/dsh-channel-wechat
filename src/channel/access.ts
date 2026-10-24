/**
 * Who may drive a conversation through this channel.
 *
 * The transport has no notion of an owner. `getUpdates` returns every message
 * the bot receives, and the inbound parser turns any sender into a session key -
 * so without a gate, anyone who can message the bot drives the agent, and not
 * merely as a chat partner: the same path reaches `/model` (which rewrites this
 * plugin's configured provider and model), `/cwd` (which moves the conversation
 * to any directory on the host), and every command the harness exposes. The
 * exposure is configuration and filesystem, not just tokens.
 *
 * So the gate is a policy, and it lives here rather than in the channel so it
 * can be read as one rule: **the login that scanned the QR code is the owner,
 * and nobody else is admitted unless named**.
 *
 * The default is what makes that rule safe *and* compatible: an empty
 * `allow` field admits the owner alone. Failing closed for everyone would mean
 * that upgrading the plugin silently mutes every existing installation -
 * indistinguishable from a broken channel, and previously the exact shape of a
 * defect that left users waiting for answers. Admitting the owner needs no
 * configuration because the login already recorded their id.
 *
 * @module dsh-channel-wechat/channel/access
 */

/** What the policy is built from. */
export interface AccessPolicyOptions {
  /**
   * Peers named by the operator, one per line or comma-separated.
   *
   * A string rather than an array because the GUI's settings form writes
   * single-segment paths: a nested list would render a control whose save cannot
   * address it, which is the same reason `provider` and `model` are flat fields.
   */
  allow?: string | undefined
  /**
   * The id of the user who scanned the login QR code.
   *
   * Read from the stored credential, where the server's `ilink_user_id` was
   * recorded at login. Absent when the server never issued one - a protocol
   * field that this channel must not assume is present.
   */
  owner?: string | undefined
}

/** The decision the channel asks for before doing anything with a message. */
export interface AccessPolicy {
  /**
   * Whether one sender may use this channel.
   * @param peerId - the sender id from the wire.
   * @returns true when the message may be handled.
   */
  allows: (peerId: string) => boolean
  /**
   * Whether anything is admitted at all.
   *
   * Distinguishes "the owner is not configured and no allow list exists" from
   * "this particular stranger is refused", which are different things to tell an
   * operator: the first is a deployment that will silently drop everything, and
   * is worth reporting at start rather than only when a message arrives.
   */
  admitsAnyone: () => boolean
}

/**
 * Split the configured list into peer ids.
 *
 * Newlines and commas both separate entries: a single id is the common case, a
 * pasted column of them is the other, and neither should need its own explanation
 * in the configuration page.
 * @param value - the configured `allow` value.
 * @returns the ids, trimmed, without empties.
 */
export function parseAllowList(value: string | undefined): string[] {
  if (value === undefined) return []
  return value
    .split(/[\n,]/u)
    .map(entry => entry.trim())
    .filter(entry => entry !== '')
}

/**
 * Build the admission policy from this channel's configuration and its login.
 *
 * An explicit list is authoritative: naming anyone means the operator is saying
 * who is admitted, and quietly adding the owner on top would make the list
 * disagree with the file it was read from. An empty list falls back to the owner,
 * which is the zero-configuration case.
 *
 * @param options - the configured list and the recorded owner.
 * @returns the policy.
 */
export function createAccessPolicy(options: AccessPolicyOptions = {}): AccessPolicy {
  const listed = parseAllowList(options.allow)
  const owner = options.owner?.trim()
  const admitted = new Set(listed.length > 0 ? listed : owner === undefined || owner === '' ? [] : [owner])

  return {
    allows: peerId => admitted.has(peerId),
    admitsAnyone: () => admitted.size > 0,
  }
}

// Host half of dsh-complete-notify.
//
// Deliberately empty: every behavior (completion detection, sound, toast,
// system notification, settings) lives in the browser client. The host half
// exists only so the package satisfies the bundle loader on the Node side.
export const name = 'dsh-complete-notify'

export function apply(_ctx) {
  // no host-side work
}

// The one announcer for assistive technology: new commits, new inbox items and action results. Visually hidden but in
// the accessibility tree. Each message sits in a node keyed by its id, so a new message (even the same text again) is a
// fresh node and is announced again, while an unchanged one is not read twice.
import { styles } from "./styles.js";
import type { Notice } from "./notice.js";

export interface LiveRegionProps {
  /** New commits and inbox items from the state diff. */
  readonly announcement: Notice;
  /** The result of the last action. */
  readonly notice: Notice;
}

export function LiveRegion({ announcement, notice }: LiveRegionProps) {
  return (
    <div aria-live="polite" aria-atomic="false" style={styles.srOnly}>
      <p key={`a-${announcement.id}`}>{announcement.text}</p>
      <p key={`n-${notice.id}`}>{notice.text}</p>
    </div>
  );
}

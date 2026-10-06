/**
 * Tracks the page/system state that can stop counting:
 *  - screen lock (reported by the background via chrome.idle)
 *  - page lifecycle freeze (the browser suspended this tab; no playback happens)
 *
 * V1.2: tab visibility and window focus deliberately do NOT stop counting — a
 * lecture playing in a background tab while you work in another app counts.
 * Visibility/focus/pageshow events are still observed, but only to trigger an
 * immediate re-measurement at those moments.
 * Calls `onChange()` whenever any of these may have changed.
 */
(function (root) {
  'use strict';
  const NS = (root.__UdemyStreak = root.__UdemyStreak || {});

  class ActivityTracker {
    constructor({ onChange, signal, doc = root.document, win = root }) {
      this.doc = doc;
      this.win = win;
      this.onChange = onChange;
      this.systemLocked = false;
      this.frozen = false;

      const fire = () => this.onChange && this.onChange();
      const opts = { capture: true, signal };
      doc.addEventListener('visibilitychange', fire, opts);
      win.addEventListener('focus', fire, opts);
      win.addEventListener('blur', fire, opts);
      win.addEventListener('pageshow', fire, opts);
      doc.addEventListener('freeze', () => { this.frozen = true; fire(); }, opts);
      doc.addEventListener('resume', () => { this.frozen = false; fire(); }, opts);
    }

    setLocked(locked) { this.systemLocked = !!locked; }

    snapshot() {
      return {
        frozen: this.frozen,
        systemLocked: this.systemLocked,
      };
    }
  }

  NS.ActivityTracker = ActivityTracker;
})(globalThis);

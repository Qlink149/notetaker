import { useEffect } from 'react';

/**
 * Asks the browser to confirm before the page is closed or reloaded while `active` is true
 * (a recording is running, or one is waiting to be uploaded). Browsers show their own wording.
 */
export function useLeaveWarning(active) {
  useEffect(() => {
    if (!active) return undefined;
    const onBeforeUnload = (e) => {
      e.preventDefault();
      // older browsers need a value here to show the prompt
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [active]);
}

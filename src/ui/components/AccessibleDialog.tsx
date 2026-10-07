import React, { useEffect, useRef } from 'react';

interface AccessibleDialogProps extends React.HTMLAttributes<HTMLDivElement> {
  onDismiss: () => void;
  dismissible?: boolean;
}

interface ActiveDialog {
  element: HTMLDivElement;
  focus: () => void;
}

const activeDialogs: ActiveDialog[] = [];
const isolatedElements = new WeakMap<HTMLElement, { count: number; inert: string | null; hidden: string | null }>();
const focusableSelector = 'button, input, select, textarea, a[href], [tabindex], [contenteditable="true"]';

function isAvailable(element: HTMLElement): boolean {
  if (element.matches(':disabled, input[type="hidden"]') || element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
  for (let ancestor: HTMLElement | null = element; ancestor; ancestor = ancestor.parentElement) {
    const style = window.getComputedStyle(ancestor);
    if (style.display === 'none' || style.visibility === 'hidden') return false;
  }
  return true;
}

function focusableElements(dialog: HTMLElement): HTMLElement[] {
  return Array.from(dialog.querySelectorAll<HTMLElement>(focusableSelector))
    .filter((element) => element.tabIndex >= 0 && isAvailable(element));
}

function isolateBackground(dialog: HTMLElement): () => void {
  const isolated: HTMLElement[] = [];
  // Walk every ancestor so an inline confirmation also isolates the header and navigation.
  for (let branch: HTMLElement = dialog; branch.parentElement; branch = branch.parentElement) {
    for (const sibling of Array.from(branch.parentElement.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === branch || sibling.matches('script, style')) continue;
      const previous = isolatedElements.get(sibling);
      if (previous) previous.count += 1;
      else {
        isolatedElements.set(sibling, { count: 1, inert: sibling.getAttribute('inert'), hidden: sibling.getAttribute('aria-hidden') });
        sibling.setAttribute('inert', '');
        sibling.setAttribute('aria-hidden', 'true');
      }
      isolated.push(sibling);
    }
    if (branch.parentElement === document.body) break;
  }
  return () => {
    for (const element of isolated) {
      const previous = isolatedElements.get(element)!;
      if (--previous.count !== 0) continue;
      for (const [attribute, value] of [['inert', previous.inert], ['aria-hidden', previous.hidden]] as const) {
        if (value === null) element.removeAttribute(attribute);
        else element.setAttribute(attribute, value);
      }
      isolatedElements.delete(element);
    }
  };
}

/** A named modal boundary. Callers keep their pending/error state and decide when Escape is safe. */
export const AccessibleDialog: React.FC<AccessibleDialogProps> = ({ onDismiss, dismissible = true, children, ...props }) => {
  const dialogRef = useRef<HTMLDivElement>(null);
  const current = useRef({ onDismiss, dismissible });
  current.current = { onDismiss, dismissible };

  useEffect(() => {
    const dialog = dialogRef.current!;
    const trigger = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let lastFocused: HTMLElement | null = null;
    const entry: ActiveDialog = { element: dialog, focus: () => {
      const preferred = dialog.querySelector<HTMLElement>('[data-dialog-initial-focus]');
      const target = lastFocused?.isConnected && dialog.contains(lastFocused) && isAvailable(lastFocused)
        ? lastFocused : preferred && isAvailable(preferred) ? preferred : focusableElements(dialog)[0] ?? dialog;
      target.focus();
    } };
    const isTop = () => activeDialogs.at(-1) === entry;
    activeDialogs.push(entry);
    entry.focus();
    const restoreBackground = isolateBackground(dialog);

    const onFocus = (event: FocusEvent) => {
      if (!isTop()) return;
      if (event.target instanceof HTMLElement && dialog.contains(event.target)) lastFocused = event.target;
      else entry.focus();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!isTop() || event.isComposing) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        if (current.current.dismissible) current.current.onDismiss();
      } else if (event.key === 'Tab' && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        const elements = focusableElements(dialog);
        const index = elements.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (index <= 0 ? elements.length - 1 : index - 1) : (index + 1) % elements.length;
        (elements[next] ?? dialog).focus();
      }
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('keydown', onKey, true);
    // Keep focus inside when pending state disables controls or a result replaces the form.
    const observer = new MutationObserver(() => {
      if (isTop() && (!(document.activeElement instanceof HTMLElement)
        || !dialog.contains(document.activeElement) || !isAvailable(document.activeElement))) entry.focus();
    });
    observer.observe(dialog, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled', 'hidden', 'tabindex'] });
    return () => {
      observer.disconnect();
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('keydown', onKey, true);
      const wasTop = isTop();
      activeDialogs.splice(activeDialogs.indexOf(entry), 1);
      restoreBackground();
      if (wasTop) {
        if (trigger?.isConnected && isAvailable(trigger)) trigger.focus();
        else activeDialogs.at(-1)?.focus();
      }
    };
  }, []);

  return <div {...props} ref={dialogRef} role="dialog" aria-modal="true" tabIndex={-1}>{children}</div>;
};

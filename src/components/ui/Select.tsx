/**
 * Custom Select — button trigger + portaled popover.
 *
 * Replaces native <select>. The native element's dropdown popup is OS-styled
 * (white background, system fonts), which clashed badly with our dark
 * theme and was unreadable on macOS Chrome (light-grey text on white bg
 * because we'd set color: var(--text-primary)).
 *
 * Keyboard:
 *   Enter/Space   → toggle open
 *   ArrowDown/Up  → move highlight
 *   Enter         → commit highlighted
 *   Esc           → close without committing
 */
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDownIcon } from '../icons';
import { clampMenuPosition } from './contextMenu';

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
  hint?: string;
}

interface Props<T extends string = string> {
  value: T;
  options: SelectOption<T>[];
  onChange: (value: T) => void;
  placeholder?: string;
  triggerClassName?: string;
  popoverClassName?: string;
  ariaLabel?: string;
  /** Render a custom label on the trigger button instead of the matching option's label. */
  triggerLabel?: React.ReactNode;
}

export function Select<T extends string = string>({
  value,
  options,
  onChange,
  placeholder,
  triggerClassName,
  popoverClassName,
  ariaLabel,
  triggerLabel,
}: Props<T>) {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState<number>(() => {
    const i = options.findIndex((o) => o.value === value);
    return i >= 0 ? i : 0;
  });
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ x: number; y: number; width: number }>({ x: 0, y: 0, width: 0 });

  const current = options.find((o) => o.value === value);

  const close = useCallback(() => {
    setOpen(false);
    triggerRef.current?.focus();
  }, []);

  const commit = useCallback((next: T) => {
    onChange(next);
    setOpen(false);
    triggerRef.current?.focus();
  }, [onChange]);

  // Anchor the popover below the trigger.
  useLayoutEffect(() => {
    if (!open) return;
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    const menuRect = popoverRef.current?.getBoundingClientRect();
    const w = menuRect?.width ?? rect.width;
    const h = menuRect?.height ?? options.length * 36 + 16;
    const { x, y } = clampMenuPosition({
      requestedX: rect.left,
      requestedY: rect.bottom + 4,
      menuWidth: w,
      menuHeight: h,
    });
    setPosition({ x, y, width: Math.max(rect.width, 160) });
  }, [open, options.length]);

  // Click-outside + Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (
        triggerRef.current?.contains(e.target as Node) ||
        popoverRef.current?.contains(e.target as Node)
      ) {
        return;
      }
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setHighlight((h) => Math.min(options.length - 1, h + 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setHighlight((h) => Math.max(0, h - 1));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const opt = options[highlight];
        if (opt) commit(opt.value);
      }
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, options, highlight, commit, close]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`select-trigger ${triggerClassName ?? ''}`}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => {
          // Reset highlight to the current value when opening.
          const i = options.findIndex((o) => o.value === value);
          if (i >= 0) setHighlight(i);
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen(true);
          }
        }}
      >
        <span className="select-trigger-label">{triggerLabel ?? current?.label ?? placeholder ?? ''}</span>
        <ChevronDownIcon className="icon-sm select-trigger-chevron" />
      </button>
      {open && createPortal(
        <div
          ref={popoverRef}
          className={`select-popover ${popoverClassName ?? ''}`}
          role="listbox"
          style={{ left: position.x, top: position.y, minWidth: position.width }}
        >
          {options.map((opt, i) => (
            <button
              key={opt.value}
              type="button"
              role="option"
              aria-selected={opt.value === value}
              className={`select-option ${i === highlight ? 'highlight' : ''} ${opt.value === value ? 'selected' : ''}`}
              onMouseEnter={() => setHighlight(i)}
              onClick={() => commit(opt.value)}
            >
              <span className="select-option-label">{opt.label}</span>
              {opt.hint && <span className="select-option-hint">{opt.hint}</span>}
            </button>
          ))}
        </div>,
        document.body,
      )}
    </>
  );
}

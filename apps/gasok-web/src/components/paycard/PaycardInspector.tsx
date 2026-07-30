import { AnimatePresence, motion } from 'framer-motion';
import { useEffect } from 'react';

export type InspectorRow = {
  label: string;
  value: string;
  href?: string;
};

type PaycardInspectorProps = {
  open: boolean;
  title: string;
  rows: InspectorRow[];
  onClose: () => void;
};

export function PaycardInspector({
  open,
  title,
  rows,
  onClose,
}: PaycardInspectorProps) {
  useEffect(() => {
    if (!open) return;

    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };

    window.addEventListener('keydown', closeOnEscape);

    return () => {
      window.removeEventListener('keydown', closeOnEscape);
    };
  }, [open, onClose]);

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          className="paycard-inspector-backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          onMouseDown={(event) => {
            if (event.currentTarget === event.target) onClose();
          }}
        >
          <motion.aside
            className="paycard-inspector"
            role="dialog"
            aria-modal="true"
            aria-label={title}
            initial={{ opacity: 0, x: 36 }}
            animate={{ opacity: 1, x: 0 }}
            exit={{ opacity: 0, x: 36 }}
            transition={{ duration: 0.24 }}
          >
            <header>
              <div>
                <span>OPENRAILS INSTRUMENT INSPECTOR</span>
                <h3>{title}</h3>
              </div>

              <button type="button" onClick={onClose}>
                CLOSE
              </button>
            </header>

            <dl>
              {rows.map((row) => (
                <div key={row.label}>
                  <dt>{row.label}</dt>
                  <dd>
                    {row.href ? (
                      <a
                        href={row.href}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {row.value} ↗
                      </a>
                    ) : (
                      row.value
                    )}
                  </dd>
                </div>
              ))}
            </dl>
          </motion.aside>
        </motion.div>
      )}
    </AnimatePresence>
  );
}

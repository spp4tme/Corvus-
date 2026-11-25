// Composants partagés par toutes les vues.
import { h, clear, append } from './dom.js';
import { icon } from './icons.js';

/** Bouton. variant : 'primary' | 'danger' | 'ghost' | undefined */
export function button({ label, icon: ic, variant, onClick, title, type = 'button', iconOnly = false, block = false, disabled, pressed, attrs = {} }) {
  const cls = ['btn', variant && `btn-${variant}`, iconOnly && 'btn-icon', block && 'btn-block'].filter(Boolean).join(' ');
  const el = h('button', {
    class: cls, type, title: title || (iconOnly ? label : undefined),
    'aria-label': iconOnly ? label : undefined,
    'aria-pressed': pressed === undefined ? undefined : String(pressed),
    disabled, ...attrs,
  }, ic ? icon(ic) : null, iconOnly ? null : label);
  if (onClick) el.addEventListener('click', onClick);
  return el;
}

/** Exécute une action asynchrone avec état « occupé » sur le bouton. */
export async function busy(btn, fn) {
  const prev = [...btn.childNodes];
  btn.disabled = true;
  btn.setAttribute('aria-busy', 'true');
  append(clear(btn), [h('span', { class: 'spinner', 'aria-hidden': 'true' }), prev.filter((n) => n.nodeType === 3)]);
  try {
    return await fn();
  } finally {
    btn.disabled = false;
    btn.removeAttribute('aria-busy');
    append(clear(btn), prev);
  }
}

let fieldSeq = 0;
/** Champ avec libellé, aide et message d'erreur. `control` est un input/select/textarea. */
export function field({ label, control, hint, span2 = false }) {
  const id = control.id || `f${++fieldSeq}`;
  control.id = id;
  const err = h('div', { class: 'field-error', id: `${id}-err`, hidden: true, 'aria-live': 'polite' });
  const hintEl = hint ? h('div', { class: 'field-hint', id: `${id}-hint` }, hint) : null;
  if (hintEl) control.setAttribute('aria-describedby', `${id}-hint`);
  const wrap = h('div', { class: `field${span2 ? ' span-2' : ''}` },
    h('label', { class: 'field-label', for: id }, label), control, hintEl, err);
  wrap.setError = (msg) => {
    if (msg) { err.textContent = msg; err.hidden = false; wrap.dataset.invalid = ''; control.setAttribute('aria-invalid', 'true'); }
    else { err.hidden = true; delete wrap.dataset.invalid; control.removeAttribute('aria-invalid'); }
  };
  return wrap;
}

export const input = (props = {}) => h('input', { class: 'input', type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', ...props });
export const textarea = (props = {}) => h('textarea', { class: 'textarea', autocapitalize: 'off', spellcheck: 'false', ...props });
export function select(options, props = {}) {
  return h('select', { class: 'select', ...props },
    options.map((o) => h('option', { value: o.value, selected: o.value === props.value }, o.label)));
}
export function checkbox(label, props = {}) {
  const box = h('input', { type: 'checkbox', ...props });
  const el = h('label', { class: 'check' }, box, h('span', null, label));
  el.input = box;
  return el;
}

/** Contrôle segmenté (onglets internes). */
export function segmented(items, value, onChange, { label } = {}) {
  const el = h('div', { class: 'segmented', role: 'tablist', 'aria-label': label });
  const render = (current) => {
    clear(el);
    for (const it of items) {
      el.appendChild(h('button', {
        type: 'button', role: 'tab', 'aria-selected': String(it.value === current),
        onclick: () => { render(it.value); onChange(it.value); },
      }, it.label));
    }
  };
  render(value);
  el.set = render;
  return el;
}

// ---------- Dialogues ----------
/**
 * Ouvre un <dialog> modal natif.
 * @returns {{el: HTMLDialogElement, close: Function, closed: Promise<any>, body: HTMLElement, foot: HTMLElement}}
 */
export function openDialog({ title, body, actions = [], wide = false, onClose, beforeClose }) {
  let resolveClosed;
  const closed = new Promise((r) => { resolveClosed = r; });
  const bodyEl = h('div', { class: 'dlg-body' }, body);
  const foot = h('div', { class: 'dlg-foot' }, actions);
  const titleId = `dlg-${++fieldSeq}`;
  const dlg = h('dialog', { class: `dlg${wide ? ' dlg-wide' : ''}`, 'aria-labelledby': titleId },
    h('div', { class: 'dlg-head' },
      h('h2', { id: titleId, class: 'ellipsis' }, title),
      button({ label: 'Fermer', icon: 'close', iconOnly: true, variant: 'ghost', onClick: () => dismiss() })),
    bodyEl,
    actions.length ? foot : null);
  let result;
  const close = (value) => { result = value; if (dlg.open) dlg.close(); };
  // Fermeture à l'initiative de l'utilisateur (bouton ×, Échap) : `beforeClose` peut la refuser
  // (ex. modifications non enregistrées).
  const dismiss = async () => {
    if (beforeClose && !(await beforeClose())) return;
    close();
  };
  dlg.addEventListener('cancel', (e) => {
    if (!beforeClose) return;
    e.preventDefault();
    dismiss();
  });
  dlg.addEventListener('close', () => {
    dlg.remove();
    onClose?.(result);
    resolveClosed(result);
  });
  document.body.appendChild(dlg);
  dlg.showModal();
  return { el: dlg, close, closed, body: bodyEl, foot };
}

export function confirmDialog({ title, message, confirmLabel = 'Confirmer', danger = false }) {
  const d = openDialog({
    title,
    body: h('p', null, message),
    actions: [
      button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close(false) }),
      button({ label: confirmLabel, variant: danger ? 'danger' : 'primary', onClick: () => d.close(true) }),
    ],
  });
  return d.closed.then((v) => v === true);
}

export function promptDialog({ title, label, value = '', confirmLabel = 'Valider', hint, validate }) {
  const inp = input({ value });
  const f = field({ label, control: inp, hint });
  const form = h('form', { class: 'stack', novalidate: true }, f);
  const d = openDialog({
    title,
    body: form,
    actions: [
      button({ label: 'Annuler', variant: 'ghost', onClick: () => d.close(null) }),
      button({ label: confirmLabel, variant: 'primary', onClick: () => submit() }),
    ],
  });
  const submit = () => {
    const v = inp.value.trim();
    const err = !v ? 'Champ requis' : validate?.(v);
    if (err) { f.setError(err); inp.focus(); return; }
    d.close(v);
  };
  form.addEventListener('submit', (e) => { e.preventDefault(); submit(); });
  setTimeout(() => { inp.focus(); inp.select(); }, 30);
  return d.closed;
}

// ---------- Toasts ----------
let toastHost;
export function toast(message, type = 'info', ms = 4000) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast toast-${type}` }, message);
  toastHost.appendChild(t);
  setTimeout(() => t.remove(), ms);
}
export const toastError = (err) => toast(err?.message || String(err), 'error', 6000);

// ---------- États ----------
export function loadingState(text = 'Chargement…') {
  return h('div', { class: 'state', role: 'status' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('div', null, text));
}

export function emptyState({ icon: ic = 'search', title, text, action }) {
  const svg = icon(ic);
  svg.classList.add('state-icon');
  return h('div', { class: 'state' }, svg, h('div', { class: 'state-title' }, title), text ? h('div', null, text) : null, action || null);
}

export function errorState(err, retry) {
  const svg = icon('warning');
  svg.classList.add('state-icon');
  return h('div', { class: 'state state-error', role: 'alert' }, svg,
    h('div', { class: 'state-title' }, 'Une erreur est survenue'),
    h('div', null, err?.message || String(err)),
    retry ? button({ label: 'Réessayer', icon: 'refresh', onClick: retry }) : null);
}

export function badge(text, kind) {
  return h('span', { class: `badge${kind ? ` badge-${kind}` : ''}` }, text);
}

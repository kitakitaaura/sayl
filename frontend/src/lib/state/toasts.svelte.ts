export type ToastKind = 'ok' | 'err' | 'info';

export interface Toast {
  id: number;
  msg: string;
  kind: ToastKind;
  leaving: boolean;
}

class Toasts {
  list = $state<Toast[]>([]);
  private n = 0;

  push(msg: string, kind: ToastKind = 'info'): void {
    const id = ++this.n;
    this.list.push({ id, msg, kind, leaving: false });
    if (this.list.length > 3) this.list.shift();
    setTimeout(() => this.dismiss(id), kind === 'err' ? 5000 : 3200);
  }

  dismiss(id: number): void {
    const t = this.list.find((x) => x.id === id);
    if (!t) return;
    t.leaving = true;
    setTimeout(() => {
      this.list = this.list.filter((x) => x.id !== id);
    }, 200);
  }
}

export const toasts = new Toasts();

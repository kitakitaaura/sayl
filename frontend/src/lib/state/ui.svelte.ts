/** Which dialog is open. Only one at a time. */

export interface Intent {
  seed: boolean;
  sequential: boolean;
}

export type DialogState =
  | { kind: 'files'; hash: string; intent: Intent }
  | { kind: 'download'; hash: string }
  | { kind: 'remove'; hash: string }
  | { kind: 'confirm'; title: string; text: string; label: string; run: () => Promise<void> }
  | null;

class Ui {
  dialog = $state<DialogState>(null);

  open(d: NonNullable<DialogState>): void {
    this.dialog = d;
  }

  close(): void {
    this.dialog = null;
  }
}

export const ui = new Ui();

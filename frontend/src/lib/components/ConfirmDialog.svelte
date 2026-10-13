<script lang="ts">
  import Dialog from './Dialog.svelte';

  let { title, text, label, run, onclose }: { title: string; text: string; label: string; run: () => Promise<void>; onclose: () => void } = $props();

  async function yes() {
    // read the prop before closing: once the dialog is gone it no longer resolves
    const action = run;
    onclose();
    await action();
  }
</script>

<Dialog {title} small {onclose}>
  <p class="text">{text}</p>
  {#snippet footer()}
    <button type="button" class="btn" onclick={onclose}>cancel</button>
    <button type="button" class="btn danger" data-autofocus onclick={yes}>{label}</button>
  {/snippet}
</Dialog>

<style>
  .text {
    margin: 0;
    padding: 0 16px 14px;
    font-size: 13px;
    color: var(--fg-2);
  }
</style>

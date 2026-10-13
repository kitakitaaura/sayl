<script lang="ts">
  import { APP_NAME, APP_NAME_ARABIC } from '$lib/config';
  import Glyph from './Glyph.svelte';
</script>

<div class="brand">
  <Glyph size={38} />
  <span class="wordmark">{APP_NAME.toLowerCase()}</span>
  <span class="ar arabic" lang="ar" dir="rtl">{APP_NAME_ARABIC}</span>
</div>

<style>
  .brand {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 10px;
    margin-bottom: 6px;
  }
  .wordmark {
    font-size: 30px;
    font-weight: 600;
    letter-spacing: -0.03em;
    line-height: 1;
  }
  .ar {
    font-size: 15px;
    color: var(--muted);
    align-self: flex-end;
  }
</style>

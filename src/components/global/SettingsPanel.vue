<template>
  <section
    :class="['settings-panel', { 'settings-panel--dense': dense }]"
    :data-testid="`settings-panel-${helpTopic}`"
  >
    <div class="settings-panel__header">
      <div class="settings-panel__title">{{ title }}</div>
      <div v-if="$slots.actions || helpMode === 'dialog'" class="settings-panel__header-actions">
        <slot name="actions" />
        <q-btn
          v-if="helpMode === 'dialog'"
          flat
          round
          dense
          icon="help_outline"
          class="settings-panel__help"
          :aria-label="`查看${title}说明`"
          :data-testid="`settings-help-${helpTopic}`"
          @click="emit('request-help', helpTopic)"
        />
      </div>
    </div>

    <div class="settings-panel__content">
      <slot />
    </div>

    <p
      v-if="helpMode !== 'dialog' && ($slots.description || description)"
      class="settings-panel__description"
      :data-testid="`settings-help-${helpTopic}`"
    >
      <slot name="description">{{ description }}</slot>
    </p>
  </section>
</template>

<script setup>
defineProps({
  title: { type: String, required: true },
  description: { type: String, default: "" },
  helpMode: {
    type: String,
    default: "inline",
    validator: (value) => ["inline", "tooltip", "dialog"].includes(value),
  },
  helpTopic: { type: String, required: true },
  dense: { type: Boolean, default: false },
  details: { type: Array, default: () => [] },
});

const emit = defineEmits(["request-help"]);
</script>

<style scoped>
.settings-panel {
  min-width: 0;
  padding: 14px;
  border: 1px solid var(--settings-border, rgba(17, 24, 39, 0.08));
  border-radius: 16px;
  background: var(--settings-mini-surface, rgba(255, 255, 255, 0.72));
}

.settings-panel--dense {
  padding: 12px;
}

.settings-panel__header {
  display: flex;
  min-height: 44px;
  align-items: center;
  gap: 8px;
  margin-bottom: 10px;
}

.settings-panel__title {
  min-width: 0;
  flex: 1 1 auto;
  color: var(--settings-text-primary, rgba(17, 24, 39, 0.92));
  font-size: 14px;
  font-weight: 500;
  line-height: 1.4;
}

.settings-panel__header-actions {
  display: flex;
  flex: 0 0 auto;
  align-items: center;
  gap: 4px;
}

.settings-panel__help {
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  color: var(--settings-text-secondary, rgba(17, 24, 39, 0.62));
}

.settings-panel__content {
  min-width: 0;
}

.settings-panel__content :deep(.q-field) {
  width: 100%;
}

.settings-panel__description {
  margin: 10px 0 0;
  color: var(--settings-text-secondary, rgba(17, 24, 39, 0.62));
  font-size: 12px;
  line-height: 1.55;
}
</style>

<template>
  <q-dialog :model-value="modelValue" @update:model-value="$emit('update:modelValue', $event)">
    <q-card class="processing-result-dialog">
      <q-card-section class="row items-center no-wrap q-gutter-sm">
        <q-icon :name="statusMeta.icon" :color="statusMeta.color" size="24px" />
        <div class="col">
          <div class="text-subtitle1">{{ title || statusMeta.label }}</div>
          <div class="text-caption text-grey-7">
            共 {{ summary.total_count || 0 }} 张，成功 {{ summary.success_count || 0 }} 张，
            失败 {{ summary.failed_count || 0 }} 张，跳过 {{ summary.skipped_count || 0 }} 张
          </div>
        </div>
      </q-card-section>

      <q-separator />

      <q-card-section class="processing-result-list q-pa-none">
        <q-list separator>
          <q-item v-for="(result, index) in issueResults" :key="result.id || `${index}`">
            <q-item-section avatar>
              <q-icon
                :name="isSkipped(result) ? 'skip_next' : 'error_outline'"
                :color="isSkipped(result) ? 'grey-7' : 'negative'"
              />
            </q-item-section>
            <q-item-section>
              <q-item-label>{{ getResultName(result, index) }}</q-item-label>
              <q-item-label caption>
                {{ getResultReason(result) }}
                <span v-if="result.error_code">（{{ result.error_code }}）</span>
              </q-item-label>
            </q-item-section>
            <q-item-section side>
              <q-badge
                outline
                :color="isSkipped(result) ? 'grey-7' : 'negative'"
                :label="isSkipped(result) ? '已跳过' : '失败'"
              />
            </q-item-section>
          </q-item>
        </q-list>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat no-caps color="primary" label="关闭" v-close-popup />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed } from "vue";
import { isSkippedImageProcessingResult } from "src/utils/imageProcessingResults";

const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
  title: {
    type: String,
    default: "",
  },
  summary: {
    type: Object,
    default: () => ({}),
  },
});

defineEmits(["update:modelValue"]);

const statusMeta = computed(() => {
  const statuses = {
    completed: { label: "处理完成", icon: "check_circle", color: "positive" },
    partial: { label: "部分处理完成", icon: "warning_amber", color: "warning" },
    skipped: { label: "处理已跳过", icon: "skip_next", color: "grey-7" },
    failed: { label: "处理失败", icon: "error_outline", color: "negative" },
  };
  return statuses[props.summary?.status] || statuses.failed;
});

const isSkipped = (result) => isSkippedImageProcessingResult(result);

const issueResults = computed(() =>
  (Array.isArray(props.summary?.results) ? props.summary.results : []).filter(
    (result) => result?.success !== true
  )
);

const getResultName = (result = {}, index = 0) =>
  result.file_name ||
  result.relative_path ||
  String(result.image_path || "").split(/[\\/]/).pop() ||
  result.id ||
  `第 ${index + 1} 张图片`;

const getResultReason = (result = {}) =>
  result.error || result.missing_reason || result.reason || (isSkipped(result) ? "已按策略跳过" : "处理失败");
</script>

<style scoped>
.processing-result-dialog {
  width: min(620px, 92vw);
  max-height: min(720px, 86vh);
  border-radius: 8px;
}

.processing-result-list {
  max-height: min(460px, 56vh);
  overflow-y: auto;
}
</style>

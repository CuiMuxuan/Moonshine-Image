<template>
  <div class="model-capability-radar">
    <svg
      class="radar-svg"
      viewBox="0 0 420 360"
      role="img"
      :aria-label="ariaLabel"
    >
      <g class="radar-grid">
        <polygon
          v-for="level in gridLevels"
          :key="level"
          :points="getPolygonPoints(level / CAPABILITY_MAX)"
          class="radar-grid-polygon"
        />
        <line
          v-for="axis in axes"
          :key="axis.key"
          :x1="centerX"
          :y1="centerY"
          :x2="axis.point.x"
          :y2="axis.point.y"
          class="radar-axis"
        />
      </g>

      <polygon :points="valuePolygon" class="radar-value" />
      <polygon :points="valuePolygon" class="radar-value-line" />

      <g v-for="axis in axes" :key="`${axis.key}-label`">
        <text
          :x="axis.labelPoint.x"
          :y="axis.labelPoint.y"
          :text-anchor="axis.textAnchor"
          dominant-baseline="middle"
          class="radar-label"
        >
          {{ axis.label }}
        </text>
      </g>
    </svg>

    <div class="radar-legend">
      <div
        v-for="axis in axes"
        :key="`${axis.key}-score`"
        class="radar-legend-item"
      >
        <span>{{ axis.label }}</span>
        <strong>{{ formatCapabilityValue(getCapabilityValue(axis.key)) }}/10</strong>
      </div>
    </div>
  </div>
</template>

<script setup>
import { computed } from "vue";

const CAPABILITY_LABELS = Object.freeze([
  { key: "speed", label: "处理速度" },
  { key: "realImageQuality", label: "真实图像" },
  { key: "cartoonImageQuality", label: "卡通图像" },
  { key: "simpleSceneQuality", label: "简单场景" },
  { key: "complexSceneQuality", label: "复杂场景" },
  { key: "textWatermarkAbility", label: "文字/水印" },
  { key: "lowVramFriendly", label: "低显存" },
  { key: "stability", label: "稳定性" },
]);

const props = defineProps({
  capabilities: {
    type: Object,
    default: () => ({}),
  },
  modelLabel: {
    type: String,
    default: "模型",
  },
});

const CAPABILITY_MAX = 10;
const centerX = 210;
const centerY = 180;
const radius = 104;
const labelRadius = 150;
const gridLevels = [2, 4, 6, 8, 10];

const getCapabilityValue = (key) => {
  const value = Number(props.capabilities?.[key] ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(CAPABILITY_MAX, Math.round(value * 10) / 10));
};

const getPoint = (index, value, distance = radius) => {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / CAPABILITY_LABELS.length;
  return {
    x: centerX + Math.cos(angle) * distance * value,
    y: centerY + Math.sin(angle) * distance * value,
  };
};

const formatPoint = (point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;
const formatCapabilityValue = (value) => Number(value || 0).toFixed(1);

const getPolygonPoints = (scale) =>
  CAPABILITY_LABELS
    .map((_, index) => formatPoint(getPoint(index, scale)))
    .join(" ");

const axes = computed(() =>
  CAPABILITY_LABELS.map((item, index) => {
    const point = getPoint(index, 1);
    const labelPoint = getPoint(index, 1, labelRadius);
    let textAnchor = "middle";
    if (labelPoint.x < centerX - 16) textAnchor = "end";
    if (labelPoint.x > centerX + 16) textAnchor = "start";
    return {
      ...item,
      point,
      labelPoint,
      textAnchor,
    };
  })
);

const valuePolygon = computed(() =>
  CAPABILITY_LABELS
    .map((item, index) =>
      formatPoint(getPoint(index, getCapabilityValue(item.key) / CAPABILITY_MAX))
    )
    .join(" ")
);

const ariaLabel = computed(() => `${props.modelLabel}能力雷达图`);
</script>

<style scoped>
.model-capability-radar {
  display: grid;
  grid-template-columns: minmax(280px, 380px) minmax(180px, 1fr);
  gap: 20px;
  align-items: center;
}

.radar-svg {
  display: block;
  width: 100%;
  max-width: 380px;
  aspect-ratio: 7 / 6;
  overflow: visible;
}

.radar-grid-polygon {
  fill: none;
  stroke: rgba(17, 24, 39, 0.16);
  stroke-width: 1;
}

.radar-axis {
  stroke: rgba(17, 24, 39, 0.12);
  stroke-width: 1;
}

.radar-value {
  fill: rgba(25, 118, 210, 0.22);
}

.radar-value-line {
  fill: none;
  stroke: var(--q-primary);
  stroke-width: 2.5;
  stroke-linejoin: round;
}

.radar-label {
  fill: currentColor;
  font-size: 13px;
  font-weight: 600;
  paint-order: stroke;
  stroke: var(--q-card, #fff);
  stroke-width: 3px;
  stroke-linejoin: round;
}

.radar-legend {
  display: grid;
  gap: 8px;
  min-width: 0;
}

.radar-legend-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  min-height: 36px;
  padding: 7px 12px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.04);
}

.radar-legend-item span {
  min-width: 0;
  line-height: 1.35;
  overflow-wrap: anywhere;
}

.radar-legend-item strong {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}

:global(body.body--dark) .radar-grid-polygon {
  stroke: rgba(255, 255, 255, 0.18);
}

:global(body.body--dark) .radar-axis {
  stroke: rgba(255, 255, 255, 0.14);
}

:global(body.body--dark) .radar-legend-item {
  background: rgba(255, 255, 255, 0.06);
}

:global(body.body--dark) .radar-label {
  stroke: var(--q-dark-page, #121212);
}

@media (max-width: 760px) {
  .model-capability-radar {
    grid-template-columns: 1fr;
  }

  .radar-svg {
    margin: 0 auto;
    max-width: min(100%, 380px);
  }
}
</style>

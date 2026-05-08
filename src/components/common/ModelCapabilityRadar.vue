<template>
  <div class="model-capability-radar">
    <svg
      class="radar-svg"
      viewBox="0 0 320 320"
      role="img"
      :aria-label="ariaLabel"
    >
      <g class="radar-grid">
        <polygon
          v-for="level in gridLevels"
          :key="level"
          :points="getPolygonPoints(level / gridLevels.length)"
          class="radar-grid-polygon"
        />
        <line
          v-for="axis in axes"
          :key="axis.key"
          :x1="center"
          :y1="center"
          :x2="axis.point.x"
          :y2="axis.point.y"
          class="radar-axis"
        />
      </g>

      <polygon :points="valuePolygon" class="radar-value" />
      <polyline :points="valuePolygon" class="radar-value-line" />

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
        <strong>{{ getCapabilityValue(axis.key) }}/5</strong>
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

const center = 160;
const radius = 104;
const labelRadius = 137;
const gridLevels = [1, 2, 3, 4, 5];

const getCapabilityValue = (key) => {
  const value = Number(props.capabilities?.[key] ?? 0);
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(5, Math.round(value)));
};

const getPoint = (index, value, distance = radius) => {
  const angle = -Math.PI / 2 + (index * Math.PI * 2) / CAPABILITY_LABELS.length;
  return {
    x: center + Math.cos(angle) * distance * value,
    y: center + Math.sin(angle) * distance * value,
  };
};

const formatPoint = (point) => `${point.x.toFixed(2)},${point.y.toFixed(2)}`;

const getPolygonPoints = (scale) =>
  CAPABILITY_LABELS
    .map((_, index) => formatPoint(getPoint(index, scale)))
    .join(" ");

const axes = computed(() =>
  CAPABILITY_LABELS.map((item, index) => {
    const point = getPoint(index, 1);
    const labelPoint = getPoint(index, 1, labelRadius);
    let textAnchor = "middle";
    if (labelPoint.x < center - 16) textAnchor = "end";
    if (labelPoint.x > center + 16) textAnchor = "start";
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
    .map((item, index) => formatPoint(getPoint(index, getCapabilityValue(item.key) / 5)))
    .join(" ")
);

const ariaLabel = computed(() => `${props.modelLabel}能力雷达图`);
</script>

<style scoped>
.model-capability-radar {
  display: grid;
  grid-template-columns: minmax(220px, 320px) minmax(160px, 1fr);
  gap: 16px;
  align-items: center;
}

.radar-svg {
  display: block;
  width: 100%;
  max-width: 320px;
  aspect-ratio: 1;
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
  font-size: 11px;
  font-weight: 600;
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
  padding: 6px 10px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.04);
}

.radar-legend-item span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.radar-legend-item strong {
  flex: 0 0 auto;
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

@media (max-width: 760px) {
  .model-capability-radar {
    grid-template-columns: 1fr;
  }

  .radar-svg {
    margin: 0 auto;
  }
}
</style>

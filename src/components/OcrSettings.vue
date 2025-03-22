<template>
  <div class="q-pa-md">
    <div class="text-h6 q-mb-md">OCR 设置</div>
    <q-list>
      <q-item>
        <q-item-section>
          <q-select
            v-model="ocrLangModel"
            :options="['中文', '英文', '日文']"
            label="识别语言"
            filled
            @update:model-value="updateOcrLang"
          />
        </q-item-section>
      </q-item>
      <q-item>
        <q-item-section>
          <q-toggle
            v-model="autoLayoutModel"
            label="自动版面分析"
            @update:model-value="updateAutoLayout"
          />
        </q-item-section>
      </q-item>

      <!-- 添加OCR相关的其他设置 -->
      <q-item>
        <q-item-section>
          <q-select
            v-model="ocrEngine"
            :options="[
              { label: 'PaddleOCR', value: 'paddle' },
              { label: 'Tesseract', value: 'tesseract' },
            ]"
            label="OCR引擎"
            filled
            @update:model-value="updateOcrEngine"
          />
        </q-item-section>
      </q-item>

      <q-item>
        <q-item-section>
          <q-toggle
            v-model="detectOrientation"
            label="自动检测文本方向"
            @update:model-value="updateDetectOrientation"
          />
        </q-item-section>
      </q-item>

      <q-item>
        <q-item-section>
          <q-btn
            color="primary"
            icon="play_arrow"
            label="开始识别"
            @click="startOcr"
            :disable="!hasSelectedFile"
          />
        </q-item-section>
      </q-item>
    </q-list>
  </div>
</template>

<script setup>
import { ref, watch } from "vue";

const props = defineProps({
  ocrLang: {
    type: String,
    default: "中文",
  },
  autoLayout: {
    type: Boolean,
    default: true,
  },
  hasSelectedFile: {
    type: Boolean,
    default: false,
  },
});

const emit = defineEmits([
  "update:ocrLang",
  "update:autoLayout",
  "update:ocrEngine",
  "update:detectOrientation",
  "start-ocr",
]);

// 本地模型
const ocrLangModel = ref(props.ocrLang);
const autoLayoutModel = ref(props.autoLayout);
const ocrEngine = ref({ label: "PaddleOCR", value: "paddle" });
const detectOrientation = ref(true);

// 监听属性变化
watch(
  () => props.ocrLang,
  (val) => {
    ocrLangModel.value = val;
  }
);
watch(
  () => props.autoLayout,
  (val) => {
    autoLayoutModel.value = val;
  }
);

// 使用emit函数
const updateOcrLang = (value) => {
  emit("update:ocrLang", value);
};

const updateAutoLayout = (value) => {
  emit("update:autoLayout", value);
};

const updateOcrEngine = (value) => {
  emit("update:ocrEngine", value);
};

const updateDetectOrientation = (value) => {
  emit("update:detectOrientation", value);
};

const startOcr = () => {
  emit("start-ocr");
};
</script>
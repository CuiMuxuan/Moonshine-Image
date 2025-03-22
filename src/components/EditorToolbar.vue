<template>
  <q-footer bordered class="bg-grey-8 text-white">
    <div class="row no-wrap shadow-1">
      <q-toolbar class="col-4 bg-deep-purple-2">
        <q-btn
          flat
          round
          dense
          icon="folder_open"
          class="q-mr-sm text-primary"
          @click="toggleLeftDrawer"
        >
          <q-tooltip>文件目录</q-tooltip>
        </q-btn>

        <q-file
          ref="fileInputRef"
          v-model="filesModel"
          label="选择文件"
          filled
          counter
          multiple
          append
          use-chips
          class="full-width"
          style="margin-top: 4px"
          accept=".png,.jpg,.jpeg,.webp"
          @rejected="onRejectedFiles"
          @update:model-value="updateFiles"
        >
          <!-- 其余模板内容保持不变 -->
        </q-file>
      </q-toolbar>

      <q-toolbar class="col-8 bg-deep-purple-2 text-white">
        <q-space />
        <div class="row full-width justify-end">
          <!-- 工具栏按钮组 -->
          <div class="col-12 row justify-around items-center">
            <!-- 工具栏隐显按钮 -->
            <q-btn
              v-if="currentModel === 'remove'"
              flat
              :icon="showMaskTools ? 'edit_off' : 'edit'"
              :color="showMaskTools ? 'primary' : 'white'"
              :label="
                $q.screen.gt.sm
                  ? showMaskTools
                    ? '停止绘制'
                    : '开始绘制'
                  : ''
              "
              @click="toggleShowMaskTools"
              class="col-auto"
              :disable="!selectedFile"
            >
              <q-tooltip v-if="!$q.screen.gt.sm">{{
                showMaskTools ? "隐藏绘制工具" : "显示绘制工具"
              }}</q-tooltip>
            </q-btn>

            <!-- 对比原图按钮 -->
            <q-btn
              flat
              icon="compare"
              color="primary"
              :label="$q.screen.gt.sm ? '对比原图' : ''"
              class="col-auto"
              :disable="!selectedFile"
              @click="onCompare"
            >
              <q-tooltip v-if="!$q.screen.gt.sm">对比原图</q-tooltip>
            </q-btn>

            <!-- 运行按钮 -->
            <q-btn
              flat
              icon="play_arrow"
              color="primary"
              :label="$q.screen.gt.sm ? '运行' : ''"
              class="col-auto"
              :disable="!selectedFile"
              @click="onRun"
            >
              <q-tooltip v-if="!$q.screen.gt.sm">运行</q-tooltip>
            </q-btn>

            <!-- 下载按钮 -->
            <q-btn
              flat
              icon="download"
              color="primary"
              :label="$q.screen.gt.sm ? '下载' : ''"
              class="col-auto"
              :disable="!selectedFile"
              @click="onDownload"
            >
              <q-tooltip v-if="!$q.screen.gt.sm">下载</q-tooltip>
            </q-btn>

            <!-- 右侧栏显示/隐藏按钮 -->
            <q-btn
              flat
              icon="more_vert"
              color="primary"
              class="col-auto"
              @click="toggleRightDrawer"
            >
              <q-tooltip>设置面板</q-tooltip>
            </q-btn>
          </div>
        </div>
      </q-toolbar>
    </div>
  </q-footer>
</template>

<script setup>
import { ref, watch } from 'vue';
import { useQuasar } from 'quasar';

const $q = useQuasar();
const fileInputRef = ref(null);

const props = defineProps({
  files: {
    type: Array,
    required: true
  },
  selectedFile: {
    type: Object,
    default: null
  },
  currentModel: {
    type: String,
    default: 'remove'
  },
  showMaskTools: {
    type: Boolean,
    default: true
  }
});

const emit = defineEmits([
  'update:files',
  'update:showMaskTools',
  'toggle-left-drawer',
  'toggle-right-drawer',
  'rejected-files',
  'compare',
  'run',
  'download'
]);

const filesModel = ref(props.files);

watch(() => props.files, (val) => {
  filesModel.value = val;
});

// 使用emit函数
const toggleLeftDrawer = () => {
  emit('toggle-left-drawer');
};

const toggleRightDrawer = () => {
  emit('toggle-right-drawer');
};

const updateFiles = (value) => {
  emit('update:files', value);
};

const onRejectedFiles = (event) => {
  emit('rejected-files', event);
};

const toggleShowMaskTools = () => {
  emit('update:showMaskTools', !props.showMaskTools);
};

const onCompare = () => {
  emit('compare');
};

const onRun = () => {
  emit('run');
};

const onDownload = () => {
  emit('download');
};
</script>
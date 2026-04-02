<template>
  <q-dialog v-model="showDialog" persistent class="settings-dialog">
    <q-card class="settings-card">
      <q-card-section class="row items-center q-pb-none">
        <div class="text-h6">全局设置</div>
        <q-space />
        <q-btn icon="close" flat round dense v-close-popup />
      </q-card-section>

      <q-card-section class="q-pt-sm">
        <q-tabs v-model="activeTab" dense align="justify" active-color="primary" indicator-color="primary">
          <q-tab name="general" label="通用配置" />
          <q-tab name="backend" label="后端配置" />
          <q-tab name="files" label="文件管理" />
          <q-tab name="appearance" label="外观主题" />
          <q-tab name="advanced" label="高级配置" />
        </q-tabs>
        <q-separator class="q-mt-sm" />

        <q-scroll-area class="settings-scroll-area">
          <q-tab-panels v-model="activeTab" animated class="bg-transparent">
            <q-tab-panel name="general" class="q-px-none">
              <div class="section">
                <div class="row items-center q-mb-md">
                  <div>
                    <div class="text-subtitle1 text-weight-medium">快捷键配置</div>
                    <div class="text-caption text-grey-7">
                      仅在对应模块页面、且焦点不在输入框时生效。
                    </div>
                  </div>
                  <q-space />
                  <q-btn outline color="primary" icon="restart_alt" label="恢复全部默认" @click="restoreAllShortcutDefaults" />
                </div>

                <q-banner rounded class="bg-blue-1 text-blue-10 q-mb-md">
                  单键动作只能设置为单键，双键只能设置为双键，三键只能设置为三键；重复冲突会阻止保存。
                </q-banner>

                <div v-for="group in shortcutGroups" :key="group.id" class="block q-mb-md">
                  <div class="text-subtitle2 text-weight-medium">{{ group.label }}</div>
                  <div class="text-caption text-grey-7 q-mb-md">{{ group.description }}</div>

                  <div v-for="definition in group.items" :key="definition.id" class="shortcut-row" :class="{ recording: recordingShortcutId === definition.id }">
                    <div class="shortcut-meta">
                      <div class="text-body2 text-weight-medium">{{ definition.label }}</div>
                      <div class="text-caption text-grey-7">{{ definition.description }}</div>
                    </div>
                    <q-input
                      :model-value="getShortcutDisplayValue(definition.id)"
                      readonly
                      outlined
                      dense
                      class="shortcut-input"
                      :label="recordingShortcutId === definition.id ? '录制中' : '快捷键'"
                    />
                    <div class="shortcut-actions">
                      <q-btn color="primary" unelevated :label="recordingShortcutId === definition.id ? '停止录制' : '录制'" @click="toggleShortcutRecording(definition.id)" />
                      <q-btn flat color="primary" label="恢复默认" @click="restoreShortcutDefault(definition.id)" />
                    </div>
                  </div>
                </div>

                <q-banner v-for="error in shortcutErrors" :key="error" rounded class="bg-orange-1 text-orange-10 q-mb-sm">
                  {{ error }}
                </q-banner>
              </div>
            </q-tab-panel>

            <q-tab-panel name="backend" class="q-px-none">
              <div class="section q-gutter-md">
                <q-input v-model.number="localConfig.general.backendPort" label="后端端口" type="number" :min="1024" :max="65535" :error="portError" :error-message="portErrorMessage" @update:model-value="validatePort" />
                <q-select v-model="localConfig.general.launchMode" label="启动方式" emit-value map-options :options="launchModeOptions" />
                <q-input v-model="localConfig.general.backendProjectPath" label="后端项目路径" readonly>
                  <template #append><q-btn round dense flat icon="folder" @click="selectBackendProjectPath" /></template>
                </q-input>
                <q-input v-model="localConfig.general.modelPath" label="模型目录" readonly>
                  <template #append><q-btn round dense flat icon="folder" @click="selectModelPath" /></template>
                </q-input>
                <q-select v-model="localConfig.general.defaultModel" label="默认模型" :options="['lama']" />
              </div>
            </q-tab-panel>

            <q-tab-panel name="files" class="q-px-none">
              <div class="section q-gutter-md">
                <q-input v-model="localConfig.fileManagement.downloadPath" label="下载 / 导出路径" readonly>
                  <template #append><q-btn round dense flat icon="folder" @click="selectDownloadPath" /></template>
                </q-input>
                <q-input v-model="localConfig.fileManagement.tempPath" label="临时文件路径" readonly>
                  <template #append><q-btn round dense flat icon="folder" @click="selectTempPath" /></template>
                </q-input>
                <div class="grid">
                  <q-input v-model="localConfig.fileManagement.imageFolderName" label="图片输出文件夹名" />
                  <q-input v-model="localConfig.fileManagement.videoFolderName" label="视频输出文件夹名" />
                </div>
              </div>
            </q-tab-panel>

            <q-tab-panel name="appearance" class="q-px-none">
              <div class="section q-gutter-lg">
                <div class="block">
                  <div class="row items-center q-mb-md">
                    <div class="text-subtitle1 text-weight-medium">主题品牌色</div>
                    <q-space />
                    <q-btn outline color="primary" icon="restart_alt" label="恢复默认" @click="resetThemeColors" />
                  </div>
                  <div class="grid">
                    <div v-for="item in themeColorFields" :key="item.key" class="mini-block">
                      <div class="text-caption text-grey-7 q-mb-xs">{{ item.label }}</div>
                      <div class="color-row">
                        <input v-model="localConfig.ui.brandColors[item.key]" type="color" class="native-color-input" />
                        <q-input v-model="localConfig.ui.brandColors[item.key]" dense outlined :label="item.key" />
                      </div>
                    </div>
                  </div>
                </div>

                <div class="block">
                  <div class="row items-center q-mb-md">
                    <div class="text-subtitle1 text-weight-medium">按钮大小</div>
                    <q-space />
                    <q-btn outline color="primary" icon="restart_alt" label="恢复默认" @click="resetButtonSize" />
                  </div>
                  <q-select v-model="localConfig.ui.buttonSize" outlined emit-value map-options :options="buttonSizeOptions" label="绘制工具按钮大小" />
                </div>

                <div class="block">
                  <div class="row items-center q-mb-md">
                    <div class="text-subtitle1 text-weight-medium">默认画笔样式</div>
                    <q-space />
                    <q-btn outline color="primary" icon="restart_alt" label="恢复默认" @click="resetBrushDefaults" />
                  </div>

                  <div class="grid">
                    <div v-for="item in brushConfigFields" :key="item.key" class="mini-block">
                      <div class="row items-center q-mb-md">
                        <div class="text-subtitle2">{{ item.label }}</div>
                        <q-space />
                        <span class="brush-dot" :style="{ backgroundColor: getBrushConfig(item.key).color, opacity: getBrushConfig(item.key).alpha, width: `${Math.max(12, getBrushConfig(item.key).size)}px`, height: `${Math.max(12, getBrushConfig(item.key).size)}px` }"></span>
                      </div>
                      <div class="q-gutter-md">
                        <div class="color-row">
                          <input v-model="localConfig.advanced[item.key].color" type="color" class="native-color-input" />
                          <q-input v-model="localConfig.advanced[item.key].color" dense outlined label="颜色" />
                        </div>
                        <q-slider v-model="localConfig.advanced[item.key].size" label label-always :min="1" :max="120" :step="1"><template #prepend>大小</template></q-slider>
                        <q-slider v-model="localConfig.advanced[item.key].alpha" label label-always :min="0.05" :max="1" :step="0.05"><template #prepend>透明度</template></q-slider>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </q-tab-panel>

            <q-tab-panel name="advanced" class="q-px-none">
              <div class="section">
                <q-tabs v-model="advancedTab" dense active-color="primary" indicator-color="primary">
                  <q-tab name="image" label="图片处理" />
                  <q-tab name="video" label="视频处理" />
                </q-tabs>
                <q-separator class="q-my-sm" />

                <q-tab-panels v-model="advancedTab" animated class="bg-transparent">
                  <q-tab-panel name="image" class="q-pa-none">
                    <div class="q-gutter-lg">
                      <div class="grid">
                        <q-input v-model.number="localConfig.advanced.imageHistoryLimit" label="图片历史记录上限" type="number" :min="1" :max="100" />
                        <q-input v-model.number="localConfig.advanced.imageWarningSize" label="图片警告大小（MB）" type="number" :min="1" :max="1000" />
                      </div>
                      <q-input v-model.number="localConfig.advanced.stateSaveLimit" label="状态保存上限大小（MB）" type="number" :min="10" :max="500" />

                      <div class="mini-block">
                        <div class="text-subtitle2 text-weight-medium q-mb-sm">图片处理方式</div>
                        <q-select v-model="localConfig.advanced.imageProcessingMethod" :options="imageProcessingOptions" emit-value map-options outlined dense :disable="!canChangeImageProcessingMethod">
                          <template #hint>{{ getImageProcessingHint() }}</template>
                        </q-select>
                        <div v-if="!canChangeImageProcessingMethod" class="text-caption text-orange q-mt-xs">当前已有图片载入，暂时不能切换处理方式。</div>
                      </div>

                      <div class="mini-block">
                        <div class="text-subtitle2 text-weight-medium q-mb-sm">图片输出命名方式</div>
                        <q-btn-toggle v-model="localConfig.advanced.imageOutputNamingMode" spread unelevated toggle-color="primary" color="grey-3" text-color="dark" :options="imageNamingOptions" />
                        <q-input v-if="localConfig.advanced.imageOutputNamingMode === 'prefixUuid'" v-model.trim="localConfig.advanced.imageOutputFixedPrefix" outlined label="固定前缀" class="q-mt-md" />
                      </div>
                    </div>
                  </q-tab-panel>

                  <q-tab-panel name="video" class="q-pa-none">
                    <div class="grid">
                      <q-input v-model.number="localConfig.video.batchFrameCount" label="固定批次帧数" type="number" :min="1" />
                      <q-select v-model="localConfig.video.frameExtractionFormat" label="拆帧存储格式" emit-value map-options :options="frameFormatOptions" />
                      <q-input v-model.number="localConfig.video.historyLimit" label="视频历史记录上限" type="number" :min="1" :max="50" />
                      <q-input v-model.number="localConfig.video.batchRetryCount" label="批次重试次数" type="number" :min="1" :max="10" />
                      <q-input v-model.number="localConfig.video.failureRetentionCount" label="失败现场保留数量" type="number" :min="1" :max="50" />
                      <q-input v-model.number="localConfig.video.proxyMaxSide" label="代理预览最大边长" type="number" :min="256" :max="4096" />
                    </div>
                  </q-tab-panel>
                </q-tab-panels>
              </div>
            </q-tab-panel>
          </q-tab-panels>
        </q-scroll-area>
      </q-card-section>

      <q-card-section v-if="validationErrors.length" class="q-pt-none q-pb-none">
        <q-banner rounded class="bg-orange-1 text-orange-10">
          <div v-for="error in validationErrors" :key="error">{{ error }}</div>
        </q-banner>
      </q-card-section>

      <q-card-actions align="right" class="q-pa-md">
        <q-btn flat label="取消" v-close-popup />
        <q-btn color="primary" label="保存" :loading="saving" :disable="hasErrors" @click="saveSettings" />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog v-model="showConfirmDialog" persistent class="confirm-dialog">
    <q-card style="min-width: min(480px, calc(100vw - 32px))">
      <q-card-section class="row items-center q-pb-none">
        <q-avatar icon="warning" color="orange" text-color="white" />
        <div class="text-h6 q-ml-sm">确认继续</div>
      </q-card-section>
      <q-card-section>{{ confirmMessage }}</q-card-section>
      <q-card-actions align="right">
        <q-btn flat label="取消" v-close-popup />
        <q-btn color="primary" label="确认" @click="confirmAction" />
      </q-card-actions>
    </q-card>
  </q-dialog>
</template>

<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useQuasar } from "quasar";
import { ConfigManager, DEFAULT_BRAND_COLORS, DEFAULT_IMAGE_BRUSH, DEFAULT_UI_BUTTON_SIZE, DEFAULT_VIDEO_BRUSH, UI_BUTTON_SIZE_OPTIONS } from "src/config/ConfigManager";
import { createDefaultShortcuts, formatShortcutKeys, getShortcutDefinition, getShortcutTokenFromKeyboardEvent, getShortcutsByGroup, normalizeShortcutKeys, SHORTCUT_GROUP_META, SHORTCUT_GROUPS, validateShortcutConfig } from "src/utils/shortcutConfig";
import { useAppStateStore } from "src/stores/appState";
import { useConfigStore } from "src/stores/config";
import { useFileManagerStore } from "src/stores/fileManager";

const $q = useQuasar();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const fileManagerStore = useFileManagerStore();

const launchModeOptions = [{ label: "CUDA 加速", value: "cuda" }, { label: "CPU 模式", value: "cpu" }];
const imageProcessingOptions = [{ label: "文件路径（推荐）", value: "path", description: "更适合本地 Electron 批处理，前端内存压力更低。" }, { label: "Base64", value: "base64", description: "兼容性更直接，但大量图片时更占内存。" }];
const imageNamingOptions = [{ label: "原文件名", value: "original" }, { label: "固定前缀 + UUID", value: "prefixUuid" }];
const frameFormatOptions = [{ label: "JPG", value: "jpg" }, { label: "PNG", value: "png" }, { label: "WebP", value: "webp" }];
const themeColorFields = [{ key: "primary", label: "Primary" }, { key: "secondary", label: "Secondary" }, { key: "accent", label: "Accent" }];
const brushConfigFields = [{ key: "imageBrushDefault", label: "图片默认画笔" }, { key: "videoBrushDefault", label: "视频默认画笔" }];
const buttonSizeOptions = UI_BUTTON_SIZE_OPTIONS.slice().reverse().map((value) => ({ label: value.toUpperCase(), value }));

const props = defineProps({ modelValue: { type: Boolean, default: false } });
const emit = defineEmits(["update:modelValue"]);

const showDialog = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });
const activeTab = ref("general");
const advancedTab = ref("image");
const saving = ref(false);
const showConfirmDialog = ref(false);
const confirmMessage = ref("");
const pendingAction = ref(null);
const recordingShortcutId = ref("");
const recordingKeys = ref([]);
const portError = ref(false);
const portErrorMessage = ref("");

const buildSerializableConfig = (sourceConfig) => JSON.parse(JSON.stringify(ConfigManager.mergeWithDefault(sourceConfig || {})));
const localConfig = ref(buildSerializableConfig(configStore.config));
const shortcutGroups = Object.values(SHORTCUT_GROUPS).map((groupId) => ({ id: groupId, label: SHORTCUT_GROUP_META[groupId]?.label || groupId, description: SHORTCUT_GROUP_META[groupId]?.description || "", items: getShortcutsByGroup(groupId) }));
const canChangeImageProcessingMethod = computed(() => fileManagerStore.files.length === 0);
const mergedConfig = computed(() => ConfigManager.mergeWithDefault(localConfig.value));
const shortcutErrors = computed(() => validateShortcutConfig(localConfig.value.shortcuts));
const validationErrors = computed(() => {
  const errors = configStore.validateConfig(mergedConfig.value);
  return [...(portError.value && portErrorMessage.value ? [portErrorMessage.value] : []), ...errors];
});
const hasErrors = computed(() => validationErrors.value.length > 0);

const validatePort = (port) => {
  if (!port || port < 1024 || port > 65535) {
    portError.value = true;
    portErrorMessage.value = "后端端口必须在 1024-65535 范围内。";
  } else {
    portError.value = false;
    portErrorMessage.value = "";
  }
};
const getImageProcessingHint = () => imageProcessingOptions.find((item) => item.value === (localConfig.value.advanced?.imageProcessingMethod || "path"))?.description || "";
const getBrushConfig = (key) => localConfig.value.advanced?.[key] || DEFAULT_IMAGE_BRUSH;
const getShortcutDisplayValue = (actionId) => formatShortcutKeys(recordingShortcutId.value === actionId && recordingKeys.value.length ? recordingKeys.value : localConfig.value.shortcuts?.[actionId] || []);
const stopShortcutRecording = () => { recordingShortcutId.value = ""; recordingKeys.value = []; };
const resetThemeColors = () => { localConfig.value.ui.brandColors = { ...DEFAULT_BRAND_COLORS }; };
const resetButtonSize = () => { localConfig.value.ui.buttonSize = DEFAULT_UI_BUTTON_SIZE; };
const resetBrushDefaults = () => { localConfig.value.advanced.imageBrushDefault = { ...DEFAULT_IMAGE_BRUSH }; localConfig.value.advanced.videoBrushDefault = { ...DEFAULT_VIDEO_BRUSH }; };
const restoreShortcutDefault = (actionId) => { const definition = getShortcutDefinition(actionId); if (!definition) return; localConfig.value.shortcuts = { ...localConfig.value.shortcuts, [actionId]: [...definition.defaultKeys] }; if (recordingShortcutId.value === actionId) stopShortcutRecording(); };
const restoreAllShortcutDefaults = () => { localConfig.value.shortcuts = createDefaultShortcuts(); stopShortcutRecording(); };
const applyShortcutValue = (actionId, keys) => {
  const definition = getShortcutDefinition(actionId);
  if (!definition) return;
  const normalizedKeys = normalizeShortcutKeys(keys);
  if (normalizedKeys.length !== definition.keyCount) {
    $q.notify({ type: "negative", message: `${definition.label}必须使用 ${definition.keyCount} 个按键。`, position: "top" });
    return;
  }
  const nextShortcuts = { ...localConfig.value.shortcuts, [actionId]: normalizedKeys };
  const errors = validateShortcutConfig(nextShortcuts);
  if (errors.length > 0) {
    $q.notify({ type: "negative", message: errors[0], position: "top" });
    return;
  }
  localConfig.value.shortcuts = nextShortcuts;
  stopShortcutRecording();
};
const toggleShortcutRecording = (actionId) => {
  if (recordingShortcutId.value === actionId) { stopShortcutRecording(); return; }
  if (!getShortcutDefinition(actionId)) return;
  recordingShortcutId.value = actionId;
  recordingKeys.value = [];
};
const handleRecordingKeydown = (event) => {
  if (!recordingShortcutId.value) return;
  event.preventDefault();
  event.stopPropagation();
  if (event.key === "Escape") { stopShortcutRecording(); return; }
  const token = getShortcutTokenFromKeyboardEvent(event);
  const definition = getShortcutDefinition(recordingShortcutId.value);
  if (!token || !definition) return;
  const nextKeys = normalizeShortcutKeys([...recordingKeys.value, token]);
  recordingKeys.value = nextKeys;
  if (nextKeys.length > definition.keyCount) {
    $q.notify({ type: "negative", message: `${definition.label}只能设置为 ${definition.keyCount} 个按键。`, position: "top" });
    return;
  }
  if (nextKeys.length === definition.keyCount) applyShortcutValue(recordingShortcutId.value, nextKeys);
};
const handleRecordingKeyup = (event) => { if (recordingShortcutId.value) { event.preventDefault(); event.stopPropagation(); } };
const selectFolder = async (title) => {
  if (!window.electron?.ipcRenderer?.invoke) return "";
  const result = await window.electron.ipcRenderer.invoke("select-folder", { title });
  return result.canceled || result.filePaths.length === 0 ? "" : result.filePaths[0];
};
const selectDownloadPath = async () => { try { const value = await selectFolder("选择下载 / 导出目录"); if (value) localConfig.value.fileManagement.downloadPath = value; } catch (error) { $q.notify({ type: "negative", message: `选择目录失败：${error.message}` }); } };
const selectTempPath = async () => { try { const value = await selectFolder("选择临时文件目录"); if (value) localConfig.value.fileManagement.tempPath = value; } catch (error) { $q.notify({ type: "negative", message: `选择目录失败：${error.message}` }); } };
const selectModelPath = async () => { try { const value = await selectFolder("选择模型目录"); if (value) localConfig.value.general.modelPath = value; } catch (error) { $q.notify({ type: "negative", message: `选择模型目录失败：${error.message}` }); } };
const selectBackendProjectPath = async () => {
  if (!window.electron?.ipcRenderer?.invoke) return;
  try {
    const value = await selectFolder("选择后端项目路径");
    if (!value) return;
    const checkResult = await window.electron.ipcRenderer.invoke("check-project", value);
    if (checkResult.success) {
      localConfig.value.general.backendProjectPath = value;
      $q.notify({ type: "positive", message: "后端项目路径设置成功", position: "top" });
      return;
    }
    $q.notify({ type: "negative", message: `无效的后端项目路径：${checkResult.error}`, position: "top" });
  } catch (error) {
    $q.notify({ type: "negative", message: `选择后端项目路径失败：${error.message}`, position: "top" });
  }
};
const doSaveSettings = async () => {
  saving.value = true;
  try {
    stopShortcutRecording();
    const serializableConfig = buildSerializableConfig(localConfig.value);
    const previousPort = configStore.config.general.backendPort;
    const storeResult = await configStore.persistConfig(serializableConfig);
    if (!storeResult.success) throw new Error(storeResult.error || storeResult.errors?.join("；") || "保存配置失败");
    if (serializableConfig.advanced?.imageProcessingMethod) {
      const processingMethod = serializableConfig.advanced.imageProcessingMethod;
      fileManagerStore.processingConfig.imageType = processingMethod;
      fileManagerStore.processingConfig.responseType = processingMethod;
    }
    $q.notify({ type: "positive", message: "设置保存成功", position: "top" });
    showDialog.value = false;
    if (serializableConfig.general.backendPort !== previousPort) {
      $q.notify({ type: "info", message: "端口已变更，页面将重新加载以应用新配置。", position: "top", timeout: 2000 });
      window.setTimeout(() => window.location.reload(), 2000);
    }
  } catch (error) {
    $q.notify({ type: "negative", message: `保存失败：${error.message}`, position: "top" });
  } finally {
    saving.value = false;
  }
};
const saveSettings = async () => {
  const nextConfig = buildSerializableConfig(localConfig.value);
  const previousConfig = buildSerializableConfig(configStore.config);
  if (JSON.stringify(nextConfig) !== JSON.stringify(previousConfig)) {
    const stateResult = await appStateStore.saveState();
    if (!stateResult.success && stateResult.oversized) {
      confirmMessage.value = `状态数据过大，无法保存当前页面状态（${stateResult.error}）。继续保存会刷新页面，未持久化的页面内容可能丢失，是否继续？`;
      showConfirmDialog.value = true;
      pendingAction.value = () => { void doSaveSettings(); };
      return;
    }
  }
  await doSaveSettings();
};
const confirmAction = () => { showConfirmDialog.value = false; if (pendingAction.value) { pendingAction.value(); pendingAction.value = null; } };

watch(() => props.modelValue, (opened) => { if (!opened) { stopShortcutRecording(); return; } localConfig.value = buildSerializableConfig(configStore.config); validatePort(localConfig.value.general.backendPort); }, { immediate: true });
watch(() => configStore.config, (newConfig) => { if (!showDialog.value) localConfig.value = buildSerializableConfig(newConfig); }, { deep: true });
watch(() => localConfig.value.general.backendPort, (port) => { validatePort(port); }, { immediate: true });

onMounted(() => {
  window.addEventListener("keydown", handleRecordingKeydown, true);
  window.addEventListener("keyup", handleRecordingKeyup, true);
});
onUnmounted(() => {
  window.removeEventListener("keydown", handleRecordingKeydown, true);
  window.removeEventListener("keyup", handleRecordingKeyup, true);
});
</script>

<style scoped>
.settings-dialog { z-index: 3000 !important; }
:deep(.settings-dialog .q-dialog), :deep(.settings-dialog .q-dialog__backdrop) { z-index: 3000 !important; }
.settings-card { width: min(1040px, calc(100vw - 24px)); max-width: min(1040px, calc(100vw - 24px)); }
.settings-scroll-area { height: min(70vh, 760px); }
.section { padding-top: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.block, .mini-block { border: 1px solid rgba(17, 24, 39, 0.08); border-radius: 16px; background: rgba(255, 255, 255, 0.72); }
.block { padding: 16px; }
.mini-block { padding: 14px; }
.shortcut-row { display: grid; grid-template-columns: minmax(0, 1fr) 220px auto; gap: 12px; align-items: center; padding: 14px; border-radius: 14px; background: rgba(119, 88, 196, 0.05); border: 1px solid rgba(119, 88, 196, 0.08); }
.shortcut-row.recording { border-color: rgba(25, 118, 210, 0.28); background: rgba(25, 118, 210, 0.06); }
.shortcut-meta { min-width: 0; }
.shortcut-input { min-width: 0; }
.shortcut-actions { display: flex; gap: 8px; }
.color-row { display: flex; align-items: center; gap: 12px; }
.native-color-input { width: 52px; height: 40px; border: 0; padding: 0; background: transparent; cursor: pointer; }
.color-row :deep(.q-field) { flex: 1 1 auto; }
.brush-dot { display: inline-block; border-radius: 999px; border: 1px solid rgba(255,255,255,.72); box-shadow: 0 0 0 1px rgba(17,24,39,.08); }
.confirm-dialog { z-index: 3100 !important; }
:deep(.confirm-dialog .q-dialog), :deep(.confirm-dialog .q-dialog__backdrop) { z-index: 3100 !important; }
@media (max-width: 900px) {
  .shortcut-row { grid-template-columns: 1fr; }
  .shortcut-actions { justify-content: flex-end; flex-wrap: wrap; }
}
@media (max-width: 700px) {
  .settings-card { width: calc(100vw - 12px); max-width: calc(100vw - 12px); }
}
</style>

<template>
  <div
    class="model-management-panel"
    :class="{ 'model-management-panel--dark': $q.dark.isActive }"
  >
    <div v-if="!backendRunning" class="model-empty-state">
      <q-icon name="power_settings_new" size="42px" color="warning" />
      <div>
        <div class="text-subtitle1 text-weight-medium">需要启动后端服务</div>
        <div class="text-body2 text-grey-7 q-mt-xs">
          模型状态、校验和下载由 Moonshine 后端统一管理。
        </div>
      </div>
      <q-btn
        outline
        no-caps
        color="primary"
        icon="terminal"
        label="打开后端管理"
        class="settings-action-button model-empty-action"
        @click="$emit('open-backend-manager')"
      />
    </div>

    <template v-else>
      <div class="model-management-toolbar">
        <div class="model-management-title">
          <div class="text-subtitle1 text-weight-medium">模型管理</div>
          <div class="text-caption text-grey-7">
            模型目录：{{ modelRegistry.modelDir || "后端默认目录" }}
          </div>
        </div>
        <q-space />
        <q-btn
          outline
          no-caps
          color="primary"
          icon="refresh"
          label="刷新状态"
          class="settings-action-button"
          :loading="modelRegistry.loading"
          @click="refreshModels"
        />
      </div>

      <q-banner
        v-if="modelRegistry.error"
        rounded
        class="settings-warning-banner q-mb-md"
      >
        {{ modelRegistry.error }}
      </q-banner>

      <q-banner
        v-if="runtimeNotice"
        rounded
        class="settings-info-banner q-mb-md"
      >
        {{ runtimeNotice }}
      </q-banner>

      <q-splitter
        v-model="splitterModel"
        class="model-management-splitter"
        :limits="[22, 42]"
      >
        <template #before>
          <div v-if="modelRegistry.models.length === 0" class="model-filter-empty">
            当前没有模型元数据。
          </div>
          <q-tree
            v-else
            :selected="selectedModelId"
            v-model:expanded="expandedModelTreeNodes"
            :nodes="modelTreeNodes"
            node-key="id"
            dense
            no-connectors
            selected-color="primary"
            class="model-tree"
            @update:selected="handleModelTreeSelected"
          >
            <template #default-header="{ node }">
              <div
                class="model-tree-node"
                :class="{ 'model-tree-node--leaf': node.modelId }"
              >
                <q-icon
                  v-if="node.icon"
                  :name="node.icon"
                  size="18px"
                  class="model-tree-node__icon"
                />
                <span class="model-tree-node__label">{{ node.label }}</span>
                <q-space />
                <template v-if="node.model">
                  <q-badge
                    v-if="isDefaultSamFamilyModel(node.model)"
                    color="primary"
                    outline
                    class="model-tree-node__badge"
                  >
                    默认
                  </q-badge>
                  <q-badge
                    :color="getStatusColor(node.model)"
                    class="model-tree-node__badge"
                  >
                    {{ getStatusLabel(node.model) }}
                  </q-badge>
                </template>
              </div>
            </template>
          </q-tree>
        </template>

        <template #after>
          <q-tab-panels
            v-model="selectedModelId"
            animated
            class="model-panels bg-transparent"
          >
            <q-tab-panel
              v-for="model in modelRegistry.models"
              :key="model.id"
              :name="model.id"
              class="q-pa-none"
            >
              <div class="model-detail">
                <div class="model-detail-header">
                  <div>
                    <div class="row items-center q-gutter-sm">
                      <div class="text-h6">{{ model.label || model.id }}</div>
                      <q-badge
                        v-if="isDefaultSamFamilyModel(model)"
                        color="primary"
                        outline
                      >
                        {{ getDefaultSamBadgeLabel(model) }}
                      </q-badge>
                    </div>
                    <div class="text-body2 text-grey-7 q-mt-xs">
                      {{ model.description || "暂无模型说明。" }}
                    </div>
                  </div>
                  <q-badge :color="getStatusColor(model)" class="model-status-badge">
                    {{ getStatusLabel(model) }}
                  </q-badge>
                  <q-badge :color="getTypeColor(model)" outline class="model-status-badge">
                    {{ getTypeLabel(model) }}
                  </q-badge>
                </div>

                <div class="model-action-row">
                  <q-btn
                    outline
                    no-caps
                    color="primary"
                    icon="verified"
                    label="校验"
                    class="settings-action-button"
                    :loading="verifyingModelId === model.id"
                    @click="verifyModel(model.id)"
                  />
                  <q-btn
                    v-if="isSamModel(model)"
                    outline
                    no-caps
                    color="primary"
                    :icon="isDefaultSamFamilyModel(model) ? 'check_circle' : 'flag'"
                    :label="isDefaultSamFamilyModel(model) ? getCurrentDefaultSamLabel(model) : getSetDefaultSamLabel(model)"
                    class="settings-action-button"
                    :disable="isDefaultSamFamilyModel(model)"
                    @click="setDefaultSamModel(model)"
                  >
                    <q-tooltip>
                      {{ getDefaultSamTooltip(model) }}
                    </q-tooltip>
                  </q-btn>
                  <q-btn
                    v-if="model.family === 'sam3'"
                    outline
                    no-caps
                    color="secondary"
                    icon="translate"
                    label="中文词表"
                    class="settings-action-button"
                    @click="openSam3LexiconDialog"
                  >
                    <q-tooltip>管理 SAM3 文本智能选区的颜色和名词映射</q-tooltip>
                  </q-btn>
                  <q-btn
                    v-if="canDownload(model)"
                    outline
                    no-caps
                    color="primary"
                    :icon="model.installed ? 'restart_alt' : 'download'"
                    :label="model.installed ? '重新下载' : '下载'"
                    class="settings-action-button"
                    :loading="isTaskRunning(model.id)"
                    @click="downloadModel(model)"
                  />
                  <q-btn
                    v-if="hasManualInstallGuide(model)"
                    outline
                    no-caps
                    color="secondary"
                    icon="folder_open"
                    label="手动安装"
                    class="settings-action-button"
                    @click="openManualInstallGuide(model)"
                  />
                  <q-chip
                    v-if="model.downloadable && !canDownload(model) && !hasManualInstallGuide(model)"
                    outline
                    color="grey"
                    text-color="grey-8"
                  >
                    暂无下载源
                  </q-chip>
                </div>

                <q-linear-progress
                  v-if="isTaskRunning(model.id)"
                  :value="getTaskProgress(model.id)"
                  rounded
                  color="primary"
                  class="q-mb-md"
                />

                <q-banner
                  v-if="getTaskMessage(model.id)"
                  rounded
                  :class="getTask(model.id)?.status === 'failed' ? 'settings-warning-banner' : 'settings-info-banner'"
                  class="q-mb-md"
                >
                  <div class="task-banner-content">
                    <span>{{ getTaskMessage(model.id) }}</span>
                    <q-btn
                      v-if="getTask(model.id)?.status === 'failed' && hasManualInstallGuide(model)"
                      flat
                      dense
                      no-caps
                      color="primary"
                      icon="folder_open"
                      label="查看手动安装"
                      @click="openManualInstallGuide(model)"
                    />
                  </div>
                </q-banner>

                <q-banner
                  v-if="getModelWarning(model)"
                  rounded
                  class="settings-warning-banner q-mb-md"
                >
                  {{ getModelWarning(model) }}
                </q-banner>

                <div class="model-info-grid">
                  <div class="mini-block">
                    <div class="text-subtitle2 text-weight-medium q-mb-sm">运行信息</div>
                    <div class="model-info-line">
                      <span>需要蒙版</span>
                      <strong>{{ model.requiresMask ? "是" : "否" }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>推荐设备</span>
                      <strong>{{ model.recommendedDevice || "不限" }}</strong>
                    </div>
                    <div v-if="isSamModel(model)" class="model-info-line">
                      <span>版本 / 型号</span>
                      <strong>{{ getSamVersionVariantLabel(model) }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>最低显存</span>
                      <strong>{{ formatVram(model.minimumVram) }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>设备适配</span>
                      <strong>{{ model.deviceCompatible ? "适配" : "不适配" }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>发布运行时</span>
                      <strong>{{ runtimeFlavorLabel }}</strong>
                    </div>
                    <div class="model-info-line">
                      <span>模型包</span>
                      <strong>{{ modelBundleLabel }}</strong>
                    </div>
                  </div>

                  <div class="mini-block">
                    <div class="text-subtitle2 text-weight-medium q-mb-sm">下载源</div>
                    <div class="text-caption text-grey-7 q-mb-xs">自动下载</div>
                    <div v-if="model.sourceLinks?.length" class="source-list">
                      <div
                        v-for="source in model.sourceLinks"
                        :key="source.url || source"
                        class="source-item"
                      >
                        <div class="source-copy">
                          <div class="source-label">{{ getSourceLabel(source) }}</div>
                          <div class="source-url">{{ getSourceUrl(source) }}</div>
                        </div>
                        <q-btn
                          v-if="getSourceUrl(source)"
                          flat
                          dense
                          round
                          icon="open_in_new"
                          color="primary"
                          @click="openExternalUrl(getSourceUrl(source))"
                        >
                          <q-tooltip>打开链接</q-tooltip>
                        </q-btn>
                      </div>
                    </div>
                    <div v-else class="text-body2 text-grey-7">暂无自动下载源</div>

                    <template v-if="hasManualInstallGuide(model)">
                      <q-separator class="q-my-md" />
                      <div class="manual-source-heading">
                        <div>
                          <div class="text-caption text-grey-7">副源</div>
                          <div class="text-body2">副源仅用于手动下载安装。</div>
                        </div>
                        <q-btn
                          flat
                          dense
                          no-caps
                          color="primary"
                          icon="info"
                          label="安装说明"
                          @click="openManualInstallGuide(model)"
                        />
                      </div>
                      <div v-if="model.manualSources?.length" class="source-list q-mt-sm">
                        <div
                          v-for="source in model.manualSources"
                          :key="source.url || source"
                          class="source-item"
                        >
                          <div class="source-copy">
                            <div class="source-label">{{ getSourceLabel(source) }}</div>
                            <div class="source-url">{{ getSourceUrl(source) }}</div>
                          </div>
                          <q-btn
                            v-if="getSourceUrl(source)"
                            flat
                            dense
                            round
                            icon="open_in_new"
                            color="primary"
                            @click="openExternalUrl(getSourceUrl(source))"
                          >
                            <q-tooltip>打开副源</q-tooltip>
                          </q-btn>
                        </div>
                      </div>
                    </template>
                  </div>
                </div>

                <div class="mini-block q-mt-md">
                  <div class="text-subtitle2 text-weight-medium q-mb-sm">发布与许可证</div>
                  <div class="model-info-line">
                    <span>许可证</span>
                    <strong>{{ getLicenseName(model) }}</strong>
                  </div>
                  <div
                    v-if="getLicenseUrl(model)"
                    class="model-link-line"
                  >
                    <span>{{ getLicenseUrl(model) }}</span>
                    <q-btn
                      flat
                      dense
                      round
                      icon="open_in_new"
                      color="primary"
                      @click="openExternalUrl(getLicenseUrl(model))"
                    >
                      <q-tooltip>打开许可证</q-tooltip>
                    </q-btn>
                  </div>
                  <div
                    v-if="getLicenseNote(model)"
                    class="text-caption text-grey-7 q-mt-xs"
                  >
                    {{ getLicenseNote(model) }}
                  </div>
                </div>

                <div class="mini-block q-mt-md">
                  <div class="text-subtitle2 text-weight-medium q-mb-md">模型能力</div>
                  <model-capability-radar
                    :model-label="model.label || model.id"
                    :capabilities="model.capabilities"
                  />
                </div>

                <div class="mini-block q-mt-md">
                  <div class="text-subtitle2 text-weight-medium q-mb-sm">文件状态</div>
                  <q-list dense bordered separator class="model-file-list">
                    <q-item v-for="file in model.files" :key="file.path">
                      <q-item-section>
                        <q-item-label>{{ file.label || file.path }}</q-item-label>
                        <q-item-label caption>目标相对路径：{{ file.path }}</q-item-label>
                        <q-item-label v-if="file.canonicalPath" caption>
                          正式检测路径：{{ file.canonicalPath }}
                        </q-item-label>
                        <q-item-label v-if="file.resolvedPath" caption>
                          当前检测到：{{ file.resolvedPath }}
                        </q-item-label>
                        <q-item-label
                          v-if="file.legacyDetected"
                          caption
                          class="text-warning"
                        >
                          当前使用 legacy 路径：{{ file.legacyPathUsed || file.resolvedPath }}
                        </q-item-label>
                        <q-item-label
                          v-else-if="file.legacyExists"
                          caption
                          class="text-warning"
                        >
                          已检测到 legacy 旧文件，新目录文件优先使用。
                        </q-item-label>
                        <q-item-label
                          v-if="file.legacyDetected || file.legacyExists"
                          caption
                        >
                          推荐迁移到：{{ file.migrationTarget || file.canonicalPath }}
                        </q-item-label>
                      </q-item-section>
                      <q-item-section side>
                        <q-badge :color="getFileColor(file)">
                          {{ getFileLabel(file) }}
                        </q-badge>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>
              </div>
            </q-tab-panel>
          </q-tab-panels>
        </template>
      </q-splitter>
    </template>

    <q-dialog v-model="manualInstallDialog">
      <q-card class="manual-install-dialog">
        <q-card-section class="manual-install-header">
          <div>
            <div class="text-subtitle1 text-weight-medium">手动安装模型</div>
            <div class="text-caption text-grey-7">
              {{ manualInstallModel?.label || manualInstallModel?.id || "模型文件" }}
            </div>
          </div>
          <q-space />
          <q-btn v-close-popup flat dense round icon="close">
            <q-tooltip>关闭</q-tooltip>
          </q-btn>
        </q-card-section>
        <q-separator />

        <q-card-section class="q-gutter-md">
          <q-banner rounded class="settings-info-banner">
            {{ manualInstallModel?.manualHint || defaultManualInstallHint }}
          </q-banner>

          <div class="manual-install-section">
            <div class="text-subtitle2 text-weight-medium q-mb-sm">模型目录</div>
            <div class="manual-path-row">
              <code>{{ modelRegistry.modelDir || "后端默认目录" }}</code>
              <q-btn
                flat
                dense
                round
                icon="content_copy"
                color="primary"
                :disable="!modelRegistry.modelDir"
                @click="copyText(modelRegistry.modelDir)"
              >
                <q-tooltip>复制模型目录</q-tooltip>
              </q-btn>
            </div>
          </div>

          <div class="manual-install-section">
            <div class="text-subtitle2 text-weight-medium q-mb-sm">需要放置的文件</div>
            <q-list dense bordered separator class="model-file-list">
              <q-item v-for="file in manualInstallModel?.files || []" :key="file.path">
                <q-item-section>
                  <q-item-label>{{ file.label || file.path }}</q-item-label>
                  <q-item-label caption>{{ getExpectedFilePath(file) }}</q-item-label>
                </q-item-section>
                <q-item-section side>
                  <q-btn
                    flat
                    dense
                    round
                    icon="content_copy"
                    color="primary"
                    @click="copyText(getExpectedFilePath(file))"
                  >
                    <q-tooltip>复制目标路径</q-tooltip>
                  </q-btn>
                </q-item-section>
              </q-item>
            </q-list>
          </div>

          <div v-if="manualInstallModel?.manualSources?.length" class="manual-install-section">
            <div class="text-subtitle2 text-weight-medium q-mb-sm">手动下载副源</div>
            <div class="source-list">
              <div
                v-for="source in manualInstallModel.manualSources"
                :key="source.url || source"
                class="source-item"
              >
                <div class="source-copy">
                  <div class="source-label">{{ getSourceLabel(source) }}</div>
                  <div class="source-url">{{ getSourceUrl(source) }}</div>
                </div>
                <q-btn
                  flat
                  dense
                  round
                  icon="open_in_new"
                  color="primary"
                  :disable="!getSourceUrl(source)"
                  @click="openExternalUrl(getSourceUrl(source))"
                >
                  <q-tooltip>打开副源</q-tooltip>
                </q-btn>
              </div>
            </div>
          </div>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn v-close-popup flat no-caps label="关闭" />
          <q-btn
            v-if="getPrimaryManualSourceUrl(manualInstallModel)"
            unelevated
            no-caps
            color="primary"
            icon="open_in_new"
            label="打开副源"
            @click="openExternalUrl(getPrimaryManualSourceUrl(manualInstallModel))"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>

    <q-dialog v-model="sam3LexiconDialog" persistent>
      <q-card class="sam3-lexicon-dialog">
        <q-card-section class="manual-install-header">
          <div>
            <div class="text-subtitle1 text-weight-medium">SAM3 中文词表</div>
            <div class="text-caption text-grey-7">
              颜色和名词会组合为英文短语，例如 red car。
            </div>
          </div>
          <q-space />
          <q-btn v-close-popup flat dense round icon="close">
            <q-tooltip>关闭</q-tooltip>
          </q-btn>
        </q-card-section>
        <q-separator />

        <q-card-section class="q-gutter-md">
          <q-banner rounded class="settings-info-banner">
            手动输入文本会优先使用；未输入文本时，可选择颜色、名词或两者组合生成 SAM3 prompt。
          </q-banner>

          <div v-if="sam3LexiconPath" class="text-caption text-grey-7">
            词表文件：{{ sam3LexiconPath }}
          </div>

          <q-tabs
            v-model="sam3LexiconTab"
            dense
            align="left"
            active-color="primary"
            indicator-color="primary"
          >
            <q-tab name="colors" label="颜色" />
            <q-tab name="nouns" label="名词" />
          </q-tabs>

          <q-tab-panels v-model="sam3LexiconTab" animated class="bg-transparent">
            <q-tab-panel name="colors" class="q-pa-none">
              <div class="lexicon-toolbar">
                <q-input
                  v-model="sam3LexiconFilters.colors"
                  dense
                  outlined
                  clearable
                  label="查询颜色"
                />
                <q-btn
                  outline
                  no-caps
                  color="primary"
                  icon="add"
                  label="新增颜色"
                  @click="addSam3LexiconEntry('colors')"
                />
              </div>
              <q-list dense bordered separator class="lexicon-list">
                <q-item
                  v-for="(entry, index) in filteredSam3ColorEntries"
                  :key="`color-${index}-${entry.zh}`"
                >
                  <q-item-section>
                    <div class="lexicon-entry-row">
                      <q-input v-model="entry.zh" dense outlined label="中文" />
                      <q-input v-model="entry.en" dense outlined label="英文" />
                    </div>
                  </q-item-section>
                  <q-item-section side>
                    <q-btn
                      flat
                      dense
                      round
                      color="negative"
                      icon="delete"
                      @click="removeSam3LexiconEntry('colors', entry)"
                    >
                      <q-tooltip>删除颜色</q-tooltip>
                    </q-btn>
                  </q-item-section>
                </q-item>
              </q-list>
            </q-tab-panel>

            <q-tab-panel name="nouns" class="q-pa-none">
              <div class="lexicon-toolbar">
                <q-input
                  v-model="sam3LexiconFilters.nouns"
                  dense
                  outlined
                  clearable
                  label="查询名词"
                />
                <q-btn
                  outline
                  no-caps
                  color="primary"
                  icon="add"
                  label="新增名词"
                  @click="addSam3LexiconEntry('nouns')"
                />
              </div>
              <q-list dense bordered separator class="lexicon-list">
                <q-item
                  v-for="(entry, index) in filteredSam3NounEntries"
                  :key="`noun-${index}-${entry.zh}`"
                >
                  <q-item-section>
                    <div class="lexicon-entry-row lexicon-entry-row--noun">
                      <q-input v-model="entry.zh" dense outlined label="中文" />
                      <q-input v-model="entry.en" dense outlined label="英文短语" />
                      <q-input v-model="entry.category" dense outlined label="分类" />
                    </div>
                  </q-item-section>
                  <q-item-section side>
                    <q-btn
                      flat
                      dense
                      round
                      color="negative"
                      icon="delete"
                      @click="removeSam3LexiconEntry('nouns', entry)"
                    >
                      <q-tooltip>删除名词</q-tooltip>
                    </q-btn>
                  </q-item-section>
                </q-item>
              </q-list>
            </q-tab-panel>
          </q-tab-panels>
        </q-card-section>

        <q-card-actions align="right">
          <q-btn v-close-popup flat no-caps label="取消" />
          <q-btn
            unelevated
            no-caps
            color="primary"
            icon="save"
            label="保存"
            :loading="sam3LexiconSaving"
            @click="saveSam3LexiconDialog"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </div>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from "vue";
import { useQuasar } from "quasar";

import ModelCapabilityRadar from "src/components/common/ModelCapabilityRadar.vue";
import { ConfigManager } from "src/config/ConfigManager";
import { loadSam3Lexicon, saveSam3Lexicon } from "src/services/SamLexiconService";
import { useConfigStore } from "src/stores/config";
import { useModelRegistryStore } from "src/stores/modelRegistry";

const props = defineProps({
  backendRunning: {
    type: Boolean,
    default: false,
  },
  selectedModelId: {
    type: String,
    default: "",
  },
});

const emit = defineEmits([
  "open-backend-manager",
  "model-downloaded",
  "default-sam-model-updated",
  "update:selected-model-id",
]);

const $q = useQuasar();
const configStore = useConfigStore();
const modelRegistry = useModelRegistryStore();
const splitterModel = ref(28);
const selectedModelId = ref(props.selectedModelId || "lama");
const expandedModelTreeNodes = ref([]);
const verifyingModelId = ref("");
const manualInstallDialog = ref(false);
const manualInstallModel = ref(null);
const sam3LexiconDialog = ref(false);
const sam3LexiconSaving = ref(false);
const sam3LexiconTab = ref("colors");
const sam3LexiconPath = ref("");
const sam3LexiconEntries = reactive({
  colors: [],
  nouns: [],
});
const sam3LexiconFilters = reactive({
  colors: "",
  nouns: "",
});
const defaultManualInstallHint =
  "请手动下载对应模型文件并放入当前模型目录。也可以私信作者或者加入交流群获取模型文件或百度网盘链接。";

const currentConfiguredModelDir = computed(() => {
  const generalConfig = configStore.config?.general || {};
  return String(generalConfig.modelDir || "").trim();
});

const modelRegistryRequestOptions = computed(() => ({
  modelDir: currentConfiguredModelDir.value,
}));

const createModelLeafNode = (model) => ({
  id: model.id,
  label:
    model.type === "mask"
      ? [model.modelVersion || model.familyLabel, model.variant || model.label || model.id]
          .filter(Boolean)
          .join(" / ")
      : model.label || model.id,
  icon: model.type === "mask" ? "center_focus_strong" : "image",
  modelId: model.id,
  model,
});

const createModelGroupNode = ({ id, label, icon, models }) => ({
  id,
  label,
  icon,
  children: models.map(createModelLeafNode),
});

const modelTreeNodes = computed(() => {
  const imageModels = modelRegistry.models.filter((model) => model.type === "image");
  const sam1Models = modelRegistry.models.filter((model) => model.family === "sam");
  const sam2Models = modelRegistry.models.filter((model) => model.family === "sam2");
  const sam3Models = modelRegistry.models.filter((model) => model.family === "sam3");

  return [
    {
      id: "image-models",
      label: "图片处理模型",
      icon: "image",
      children: [
        createModelGroupNode({
          id: "image-lama",
          label: "LaMa",
          icon: "auto_fix_high",
          models: imageModels.filter((model) => model.id === "lama" || model.family === "lama"),
        }),
        createModelGroupNode({
          id: "image-slbr",
          label: "SLBR",
          icon: "layers_clear",
          models: imageModels.filter((model) => model.id === "slbr" || model.family === "slbr"),
        }),
        createModelGroupNode({
          id: "image-other",
          label: "其他图片模型",
          icon: "more_horiz",
          models: imageModels.filter(
            (model) =>
              !["lama", "slbr"].includes(model.id) &&
              !["lama", "slbr"].includes(model.family)
          ),
        }),
      ].filter((node) => node.children.length > 0),
    },
    {
      id: "smart-selection-models",
      label: "智能选区模型",
      icon: "center_focus_strong",
      children: [
        createModelGroupNode({
          id: "sam1",
          label: "SAM1",
          icon: "filter_1",
          models: sam1Models,
        }),
        createModelGroupNode({
          id: "sam2",
          label: "SAM2",
          icon: "filter_2",
          models: sam2Models,
        }),
        createModelGroupNode({
          id: "sam3",
          label: "SAM3",
          icon: "filter_3",
          models: sam3Models,
        }),
      ].filter((node) => node.children.length > 0),
    },
  ];
});

const collectExpandableModelTreeNodeIds = (nodes = []) =>
  nodes.reduce((result, node) => {
    if (Array.isArray(node?.children) && node.children.length > 0) {
      result.push(node.id);
      result.push(...collectExpandableModelTreeNodeIds(node.children));
    }
    return result;
  }, []);

const runtimeFlavorLabel = computed(() => {
  const flavor = modelRegistry.runtime?.runtimeFlavor || "external";
  if (flavor === "cpu") return "CPU";
  if (flavor === "cu126") return "CUDA 12.6";
  if (flavor === "cu130") return "CUDA 13.0";
  return "外部运行时";
});

const modelBundleLabel = computed(() => {
  const bundle = modelRegistry.runtime?.modelBundle || "external-models";
  if (bundle === "bundled-models") return "内置基础模型";
  if (bundle === "external-models") return "外置模型";
  return bundle;
});

const runtimeNotice = computed(() => {
  const runtime = modelRegistry.runtime || {};
  if (runtime.runtimeFlavor === "cpu") {
    return "当前是 CPU 运行时，SAM3/SAM3.1 文本智能选区会显示为不可用；SAM1/SAM2 点选/框选仍按已安装模型和设备状态判断。";
  }
  if (runtime.externalModels) {
    return "当前包使用外置模型模式，缺失模型时请在模型管理中下载或手动放置到对应 sam/、sam2/、sam3/ 子目录。";
  }
  return "";
});

const isSamModel = (model) =>
  model?.type === "mask" && ["sam", "sam2", "sam3"].includes(model?.family);

const getSamDefaultConfigKey = (model) => {
  if (model?.family === "sam2") return "defaultSam2Model";
  if (model?.family === "sam3") return "defaultSam3Model";
  return "defaultSam1Model";
};

const getSamFamilyLabel = (model) => {
  if (model?.familyLabel) return model.familyLabel;
  if (model?.family === "sam2") return "SAM2";
  if (model?.family === "sam3") return "SAM3";
  return "SAM1";
};

const getSamVersionVariantLabel = (model) => {
  const version = model?.modelVersion || getSamFamilyLabel(model);
  const variant = model?.variant || model?.id || "";
  return [version, variant].filter(Boolean).join(" / ");
};

const isDefaultSamFamilyModel = (model) => {
  if (!isSamModel(model)) return false;
  const key = getSamDefaultConfigKey(model);
  return model.id === configStore.config.masking?.[key];
};

const getDefaultSamBadgeLabel = (model) => `默认 ${getSamFamilyLabel(model)}`;
const getCurrentDefaultSamLabel = (model) => `当前默认 ${getSamFamilyLabel(model)}`;
const getSetDefaultSamLabel = (model) => `设为默认 ${getSamFamilyLabel(model)}`;
const getDefaultSamTooltip = (model) =>
  isDefaultSamFamilyModel(model)
    ? `当前 ${getSamFamilyLabel(model)} 默认使用该模型`
    : `后续 ${getSamFamilyLabel(model)} 能力将优先使用该模型`;

const setDefaultSamModel = async (model) => {
  const mergedConfig = ConfigManager.mergeWithDefault(configStore.config);
  const key = getSamDefaultConfigKey(model);
  mergedConfig.masking[key] = model.id;
  if (model.family === "sam") {
    mergedConfig.masking.defaultSamModel = model.id;
  }
  const result = await configStore.persistConfig(mergedConfig);
  if (!result.success) {
    $q.notify({
      type: "negative",
      message: result.error || result.errors?.join("；") || "默认 SAM 模型保存失败",
      position: "top",
    });
    return;
  }
  $q.notify({
    type: "positive",
    message: `默认 ${getSamFamilyLabel(model)} 模型已更新`,
    position: "top",
  });
  emit("default-sam-model-updated", {
    family: model.family,
    modelId: model.id,
    configKey: key,
  });
};

const cloneLexiconEntry = (entry = {}) => ({
  zh: String(entry.zh || "").trim(),
  en: String(entry.en || "").trim(),
  category: String(entry.category || "").trim(),
});

const openSam3LexiconDialog = async () => {
  try {
    const lexicon = await loadSam3Lexicon();
    sam3LexiconEntries.colors.splice(
      0,
      sam3LexiconEntries.colors.length,
      ...lexicon.colors.map(cloneLexiconEntry)
    );
    sam3LexiconEntries.nouns.splice(
      0,
      sam3LexiconEntries.nouns.length,
      ...lexicon.nouns.map(cloneLexiconEntry)
    );
    sam3LexiconPath.value = lexicon.path || "";
    sam3LexiconDialog.value = true;
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "读取 SAM3 中文词表失败",
      position: "top",
    });
  }
};

const addSam3LexiconEntry = (type) => {
  const target = type === "nouns" ? sam3LexiconEntries.nouns : sam3LexiconEntries.colors;
  target.unshift(type === "nouns" ? { zh: "", en: "", category: "自定义" } : { zh: "", en: "" });
};

const removeSam3LexiconEntry = (type, entry) => {
  const target = type === "nouns" ? sam3LexiconEntries.nouns : sam3LexiconEntries.colors;
  const index = target.indexOf(entry);
  if (index >= 0) target.splice(index, 1);
};

const filterSam3LexiconEntries = (items, filter) => {
  const keyword = String(filter || "").trim().toLowerCase();
  if (!keyword) return items;
  return items.filter((entry) =>
    [entry.zh, entry.en, entry.category]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(keyword))
  );
};

const filteredSam3ColorEntries = computed(() =>
  filterSam3LexiconEntries(sam3LexiconEntries.colors, sam3LexiconFilters.colors)
);
const filteredSam3NounEntries = computed(() =>
  filterSam3LexiconEntries(sam3LexiconEntries.nouns, sam3LexiconFilters.nouns)
);

const saveSam3LexiconDialog = async () => {
  sam3LexiconSaving.value = true;
  try {
    const saved = await saveSam3Lexicon({
      colors: sam3LexiconEntries.colors,
      nouns: sam3LexiconEntries.nouns,
    });
    sam3LexiconEntries.colors.splice(
      0,
      sam3LexiconEntries.colors.length,
      ...saved.colors.map(cloneLexiconEntry)
    );
    sam3LexiconEntries.nouns.splice(
      0,
      sam3LexiconEntries.nouns.length,
      ...saved.nouns.map(cloneLexiconEntry)
    );
    sam3LexiconPath.value = saved.path || sam3LexiconPath.value;
    $q.notify({ type: "positive", message: "SAM3 中文词表已保存", position: "top" });
    sam3LexiconDialog.value = false;
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "保存 SAM3 中文词表失败",
      position: "top",
    });
  } finally {
    sam3LexiconSaving.value = false;
  }
};

const refreshModels = async () => {
  try {
    await modelRegistry.refreshModels(modelRegistryRequestOptions.value);
    ensureSelectedModel();
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "模型状态刷新失败",
      position: "top",
    });
  }
};

const handleModelTreeSelected = (nodeId) => {
  if (modelRegistry.models.some((model) => model.id === nodeId)) {
    selectedModelId.value = nodeId;
  }
};

const ensureSelectedModel = () => {
  if (modelRegistry.models.some((model) => model.id === selectedModelId.value)) {
    return;
  }
  selectedModelId.value =
    (modelRegistry.models.some((model) => model.id === props.selectedModelId)
      ? props.selectedModelId
      : "") ||
    modelRegistry.models[0]?.id ||
    "lama";
};

const verifyModel = async (modelId) => {
  verifyingModelId.value = modelId;
  try {
    await modelRegistry.verifyModel(modelId, modelRegistryRequestOptions.value);
    $q.notify({
      type: "positive",
      message: "模型校验完成",
      position: "top",
    });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "模型校验失败",
      position: "top",
    });
  } finally {
    verifyingModelId.value = "";
  }
};

const canDownload = (model) =>
  Boolean(model?.downloadable && model?.sourceLinks?.length);

const hasManualInstallGuide = (model) =>
  Boolean(model?.manualSources?.length || model?.manualHint || model?.files?.length);

const openManualInstallGuide = (model) => {
  manualInstallModel.value = model;
  manualInstallDialog.value = true;
};

const getSourceUrl = (source) => {
  if (!source) return "";
  return typeof source === "string" ? source : source.url || "";
};

const getSourceLabel = (source) => {
  if (!source) return "下载源";
  if (typeof source === "string") return source;
  return source.label || source.type || source.url || "下载源";
};

const getLicenseName = (model) => model?.license?.name || "待确认";
const getLicenseUrl = (model) => model?.license?.url || "";
const getLicenseNote = (model) => model?.license?.note || "";

const openExternalUrl = (url) => {
  if (!url) return;
  if (window.electron?.openExternal) {
    window.electron.openExternal(url);
    return;
  }
  if (window.electron?.ipcRenderer?.send) {
    window.electron.ipcRenderer.send("open-external-link", url);
    return;
  }
  window.open(url, "_blank", "noopener,noreferrer");
};

const copyText = async (text) => {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    $q.notify({
      type: "positive",
      message: "已复制",
      position: "top",
    });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "复制失败",
      position: "top",
    });
  }
};

const getExpectedFilePath = (file) => {
  const path = file?.path || "";
  if (!modelRegistry.modelDir) return path;
  const separator = modelRegistry.modelDir.includes("\\") ? "\\" : "/";
  const normalizedDir = modelRegistry.modelDir.replace(/[\\/]+$/, "");
  return `${normalizedDir}${separator}${path.replace(/[\\/]+/g, separator)}`;
};

const getPrimaryManualSourceUrl = (model) =>
  getSourceUrl(model?.manualSources?.[0]);

const downloadModel = async (model) => {
  try {
    const task = await modelRegistry.startDownload(model.id, modelRegistryRequestOptions.value);
    $q.notify({
      type: "info",
      message: "模型下载任务已开始",
      position: "top",
    });
    watchDownloadCompletion(task.id, model);
  } catch (error) {
    $q.notify({
      type: "negative",
      message: error.message || "模型下载失败",
      position: "top",
    });
  }
};

const watchDownloadCompletion = (taskId, model) => {
  const stop = watch(
    () => modelRegistry.tasks[taskId],
    (task) => {
      if (!task?.done) return;
      stop();
      if (task.status === "completed") {
        emit("model-downloaded", model.id);
      } else if (task.status === "failed" && hasManualInstallGuide(model)) {
        openManualInstallGuide(model);
      }
    },
    { deep: true }
  );
};

const getTask = (modelId) => modelRegistry.getTaskForModel(modelId);
const isTaskRunning = (modelId) => {
  const task = getTask(modelId);
  return task?.status === "queued" || task?.status === "running";
};
const getTaskProgress = (modelId) => {
  const task = getTask(modelId);
  const progress = Number(task?.progress || 0);
  return Math.max(0, Math.min(1, progress));
};
const getTaskMessage = (modelId) => {
  const task = getTask(modelId);
  if (!task) return "";
  if (task.status === "failed") return task.error || task.message || "下载失败";
  if (task.status === "completed") return task.message || "下载完成";
  if (task.status === "running") return "正在下载模型...";
  return task.message || "";
};

const getModelWarning = (model) => {
  if (model?.family === "sam3" && modelRegistry.runtime?.sam3TextPackageReason) {
    return modelRegistry.runtime.sam3TextPackageReason;
  }
  if (!model?.deviceCompatible) {
    return "当前设备或运行时不满足该模型建议条件，模型不会误报为可用。";
  }
  if (model?.corruptFiles?.length) {
    return "模型文件校验失败，请重新下载或按手动安装说明替换文件。";
  }
  const legacyFile = (model?.files || []).find((file) => file.legacyDetected);
  if (legacyFile) {
    return `当前模型仍从 legacy 根目录旧路径识别：${legacyFile.legacyPathUsed || legacyFile.resolvedPath}。建议迁移到 ${legacyFile.migrationTarget || legacyFile.canonicalPath}。`;
  }
  return "";
};

const getStatusLabel = (model) => {
  if (model.corruptFiles?.length) return "需修复";
  if (model.missingFiles?.length) return "未安装";
  if (model.installed && !model.deviceCompatible) return "已安装·设备不适配";
  if (model.installed) return "已安装";
  if (!model.deviceCompatible) return "设备不适配";
  return "未安装";
};

const getStatusColor = (model) => {
  if (model.corruptFiles?.length) return "negative";
  if (model.missingFiles?.length) return "grey";
  if (model.installed && !model.deviceCompatible) return "warning";
  if (model.installed) return "positive";
  if (!model.deviceCompatible) return "warning";
  return "grey";
};

const getTypeLabel = (model) => {
  if (model.category === "text_smart_selection") return "文本智能选区";
  if (model.category === "mask_generator") return "蒙版生成";
  if (model.type === "mask") return "蒙版模型";
  return "图片处理";
};

const getTypeColor = (model) => (model.type === "mask" ? "secondary" : "primary");

const getFileLabel = (file) => {
  if (!file.exists) return "缺失";
  if (!file.valid) return "损坏";
  return "正常";
};

const getFileColor = (file) => {
  if (!file.exists) return "grey";
  if (!file.valid) return "negative";
  return "positive";
};

const formatVram = (value) => {
  if (!value) return "不限";
  return `${Number(value).toFixed(0)} MB`;
};

watch(
  () => props.selectedModelId,
  (value) => {
    if (value && value !== selectedModelId.value) {
      selectedModelId.value = value;
    }
  }
);

watch(selectedModelId, (value) => {
  emit("update:selected-model-id", value);
});

watch(
  () => modelRegistry.models,
  () => {
    ensureSelectedModel();
  },
  { deep: true }
);

watch(
  modelTreeNodes,
  (nodes) => {
    expandedModelTreeNodes.value = collectExpandableModelTreeNodeIds(nodes);
  },
  { immediate: true, deep: true }
);

watch(
  () => props.backendRunning,
  async (running) => {
    if (running) {
      await modelRegistry.loadModels(modelRegistryRequestOptions.value);
      ensureSelectedModel();
    }
  }
);

watch(
  currentConfiguredModelDir,
  async (nextModelDir, previousModelDir) => {
    if (!props.backendRunning || nextModelDir === previousModelDir) return;
    await modelRegistry.loadModels(modelRegistryRequestOptions.value);
    ensureSelectedModel();
  }
);

onMounted(async () => {
  if (props.backendRunning) {
    await modelRegistry.loadModels(modelRegistryRequestOptions.value);
    ensureSelectedModel();
  }
});
</script>

<style scoped>
.model-management-panel {
  min-height: 0;
}

.model-empty-state {
  display: flex;
  align-items: center;
  gap: 16px;
  min-height: 180px;
  padding: 20px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
}

.model-empty-state > div {
  min-width: 0;
}

.model-empty-action {
  margin-left: auto;
  flex: 0 0 auto;
}

.model-management-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}

.model-management-title {
  min-width: 0;
}

.model-filter-empty {
  padding: 14px;
  color: rgba(75, 85, 99, 0.86);
}

.model-management-splitter {
  min-height: 560px;
}

.model-tree {
  padding-right: 10px;
}

.model-tree-node {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  width: 100%;
  min-height: 34px;
}

.model-tree-node__icon {
  flex: 0 0 auto;
  color: currentColor;
  opacity: 0.78;
}

.model-tree-node__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.model-tree-node__badge {
  flex: 0 0 auto;
  font-size: 11px;
}

.model-tree :deep(.q-tree__node-header) {
  border-radius: 8px;
  padding: 4px 8px;
}

.model-tree :deep(.q-tree__node--selected > .q-tree__node-header) {
  background: rgba(124, 93, 250, 0.12);
}

.model-panels {
  height: 100%;
}

.model-detail {
  padding-left: 16px;
  min-width: 0;
}

.model-detail-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 14px;
}

.model-status-badge {
  flex: 0 0 auto;
}

.model-action-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 10px;
  margin-bottom: 14px;
}

.model-info-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 14px;
}

.mini-block {
  padding: 14px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  border-radius: 16px;
  background: rgba(255, 255, 255, 0.72);
}

.model-info-line {
  display: flex;
  justify-content: space-between;
  gap: 12px;
  padding: 7px 0;
}

.model-link-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 7px 0;
}

.model-link-line > span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: rgba(75, 85, 99, 0.86);
}

.task-banner-content,
.manual-source-heading {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-width: 0;
}

.source-list {
  display: grid;
  gap: 8px;
}

.source-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  padding: 7px 10px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.04);
}

.source-copy {
  min-width: 0;
}

.source-label,
.source-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.source-url {
  color: rgba(75, 85, 99, 0.86);
  font-size: 12px;
}

.model-file-list {
  border-radius: 10px;
  overflow: hidden;
}

.manual-install-dialog {
  width: min(620px, calc(100vw - 32px));
}

.sam3-lexicon-dialog {
  width: min(920px, calc(100vw - 32px));
  max-height: 88vh;
}

.manual-install-header {
  display: flex;
  align-items: center;
  gap: 12px;
}

.manual-install-section {
  min-width: 0;
}

.manual-path-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 8px 10px;
  border-radius: 8px;
  background: rgba(17, 24, 39, 0.04);
}

.manual-path-row code {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lexicon-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 10px 0 12px;
}

.lexicon-toolbar .q-input {
  flex: 1 1 auto;
}

.lexicon-list {
  max-height: 420px;
  overflow: auto;
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.72);
}

.lexicon-entry-row {
  display: grid;
  grid-template-columns: minmax(120px, 1fr) minmax(140px, 1.2fr);
  gap: 10px;
  width: 100%;
}

.lexicon-entry-row--noun {
  grid-template-columns: minmax(120px, 1fr) minmax(160px, 1.3fr) minmax(100px, 0.8fr);
}

.settings-action-button {
  min-height: 40px;
}

.settings-action-button :deep(.q-btn__content) {
  justify-content: center;
  flex-wrap: nowrap;
  gap: 6px;
  white-space: nowrap;
}

.settings-info-banner {
  background: #e8efff;
  color: #233a7a;
  border: 1px solid rgba(122, 141, 190, 0.22);
}

.settings-warning-banner {
  background: #fff4d7;
  color: #735000;
  border: 1px solid rgba(230, 172, 0, 0.28);
}

.model-management-panel--dark .model-tree :deep(.q-tree__node-header) {
  color: rgba(255, 255, 255, 0.72);
}

.model-management-panel--dark .model-tree :deep(.q-tree__node--selected > .q-tree__node-header) {
  background: rgba(138, 113, 212, 0.14);
  color: var(--q-primary);
}

:global(body.body--dark) .model-empty-state,
:global(body.body--dark) .mini-block,
.model-management-panel--dark .model-empty-state,
.model-management-panel--dark .mini-block,
:global(.settings-card--dark) .model-management-panel .model-empty-state,
:global(.settings-card--dark) .model-management-panel .mini-block {
  background: #2f2f32;
  border-color: rgba(255, 255, 255, 0.12);
}

:global(body.body--dark) .mini-block,
.model-management-panel--dark .mini-block,
:global(.settings-card--dark) .model-management-panel .mini-block {
  background: #363638;
}

:global(body.body--dark) .model-management-panel :deep(.text-grey-7),
.model-management-panel--dark :deep(.text-grey-7),
:global(.settings-card--dark) .model-management-panel :deep(.text-grey-7) {
  color: rgba(255, 255, 255, 0.62) !important;
}

:global(body.body--dark) .model-info-line span,
:global(body.body--dark) .model-link-line > span,
.model-management-panel--dark .model-info-line span,
.model-management-panel--dark .model-link-line > span,
:global(.settings-card--dark) .model-management-panel .model-info-line span,
:global(.settings-card--dark) .model-management-panel .model-link-line > span {
  color: rgba(255, 255, 255, 0.68);
}

:global(body.body--dark) .model-info-line strong,
:global(body.body--dark) .source-label,
.model-management-panel--dark .model-info-line strong,
.model-management-panel--dark .source-label,
:global(.settings-card--dark) .model-management-panel .model-info-line strong,
:global(.settings-card--dark) .model-management-panel .source-label {
  color: rgba(255, 255, 255, 0.9);
}

:global(body.body--dark) .source-item,
:global(body.body--dark) .manual-path-row,
.model-management-panel--dark .source-item,
.model-management-panel--dark .manual-path-row,
:global(.settings-card--dark) .model-management-panel .source-item,
:global(.settings-card--dark) .model-management-panel .manual-path-row {
  background: rgba(255, 255, 255, 0.06);
  border: 1px solid rgba(255, 255, 255, 0.08);
}

:global(body.body--dark) .source-url,
.model-management-panel--dark .source-url,
:global(.settings-card--dark) .model-management-panel .source-url {
  color: rgba(229, 231, 235, 0.72);
}

:global(body.body--dark) .model-file-list,
.model-management-panel--dark .model-file-list,
:global(.settings-card--dark) .model-management-panel .model-file-list {
  border-color: rgba(255, 255, 255, 0.12);
}

:global(body.body--dark) .lexicon-list,
.model-management-panel--dark .lexicon-list,
:global(.settings-card--dark) .model-management-panel .lexicon-list {
  background: rgba(255, 255, 255, 0.035);
  border-color: rgba(255, 255, 255, 0.12);
}

:global(body.body--dark) .model-file-list :deep(.q-item),
.model-management-panel--dark .model-file-list :deep(.q-item),
:global(.settings-card--dark) .model-management-panel .model-file-list :deep(.q-item) {
  background: rgba(255, 255, 255, 0.035);
  color: rgba(255, 255, 255, 0.88);
}

:global(body.body--dark) .model-file-list :deep(.q-item__label--caption),
.model-management-panel--dark .model-file-list :deep(.q-item__label--caption),
:global(.settings-card--dark) .model-management-panel .model-file-list :deep(.q-item__label--caption) {
  color: rgba(255, 255, 255, 0.58);
}

:global(body.body--dark) .model-tabs :deep(.q-tab),
.model-management-panel--dark .model-tabs :deep(.q-tab),
:global(.settings-card--dark) .model-management-panel .model-tabs :deep(.q-tab) {
  color: rgba(255, 255, 255, 0.72);
}

:global(body.body--dark) .model-tabs :deep(.q-tab--active),
.model-management-panel--dark .model-tabs :deep(.q-tab--active),
:global(.settings-card--dark) .model-management-panel .model-tabs :deep(.q-tab--active) {
  background: rgba(138, 113, 212, 0.14);
  color: var(--q-primary);
}

:global(body.body--dark) .settings-info-banner,
.model-management-panel--dark .settings-info-banner,
:global(.settings-card--dark) .model-management-panel .settings-info-banner {
  background: rgba(122, 141, 190, 0.2);
  color: #dce4ff;
  border-color: rgba(122, 141, 190, 0.34);
}

:global(body.body--dark) .settings-warning-banner,
.model-management-panel--dark .settings-warning-banner,
:global(.settings-card--dark) .model-management-panel .settings-warning-banner {
  background: rgba(230, 172, 0, 0.18);
  color: #ffe1a0;
  border-color: rgba(230, 172, 0, 0.34);
}

@media (max-width: 760px) {
  .model-empty-state {
    flex-wrap: wrap;
  }

  .model-empty-action {
    width: 100%;
    margin-left: 58px;
  }

  .task-banner-content,
  .manual-source-heading {
    align-items: flex-start;
    flex-direction: column;
  }

  .lexicon-toolbar {
    display: grid;
  }

  .lexicon-entry-row,
  .lexicon-entry-row--noun {
    grid-template-columns: 1fr;
  }

  .model-management-splitter {
    min-height: 640px;
  }

  .model-detail {
    padding-left: 10px;
  }
}
</style>

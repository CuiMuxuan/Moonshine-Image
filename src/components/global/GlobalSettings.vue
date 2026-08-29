<template>
  <q-dialog v-model="showDialog" persistent class="settings-dialog" data-testid="global-settings-dialog">
    <q-card
      :class="['settings-card', { 'settings-card--dark': $q.dark.isActive }]"
      data-testid="global-settings-card"
    >
      <q-card-section class="settings-header row items-center q-pb-none">
        <div class="text-h6">全局设置</div>
        <q-space />
        <q-btn
          icon="close"
          flat
          round
          dense
          class="settings-icon-button"
          aria-label="关闭全局设置"
          v-close-popup
        />
      </q-card-section>

      <q-card-section class="settings-workspace q-pa-none">
        <nav class="settings-sidebar" aria-label="全局设置分类">
          <q-tabs
            v-model="activeTab"
            vertical
            dense
            active-color="primary"
            indicator-color="primary"
            class="settings-main-tabs"
          >
            <q-tab name="general" icon="tune" label="通用配置" data-testid="global-settings-tab-general">
              <q-tooltip>通用配置</q-tooltip>
            </q-tab>
            <q-tab name="backend" icon="dns" label="服务配置" data-testid="global-settings-tab-backend">
              <q-tooltip>服务配置</q-tooltip>
            </q-tab>
            <q-tab name="models" icon="model_training" label="模型管理" data-testid="global-settings-tab-models">
              <q-tooltip>模型管理</q-tooltip>
            </q-tab>
            <q-tab name="files" icon="folder" label="文件管理" data-testid="global-settings-tab-files">
              <q-tooltip>文件管理</q-tooltip>
            </q-tab>
            <q-tab name="appearance" icon="palette" label="外观主题" data-testid="global-settings-tab-appearance">
              <q-tooltip>外观主题</q-tooltip>
            </q-tab>
            <q-tab name="image" icon="image" label="图片处理" data-testid="global-settings-tab-image">
              <q-tooltip>图片处理</q-tooltip>
            </q-tab>
            <q-tab name="video" icon="videocam" label="视频处理" data-testid="global-settings-tab-video">
              <q-tooltip>视频处理</q-tooltip>
            </q-tab>
            <q-tab name="updates" icon="system_update_alt" label="应用更新" data-testid="global-settings-tab-updates">
              <q-tooltip>应用更新</q-tooltip>
            </q-tab>
            <q-tab name="mcp" icon="hub" label="MCP" data-testid="global-settings-tab-mcp">
              <q-tooltip>MCP</q-tooltip>
            </q-tab>
          </q-tabs>
        </nav>
        <q-separator vertical />

        <div class="settings-content-section">
          <q-scroll-area class="settings-scroll-area">
          <q-tab-panels v-model="activeTab" animated class="bg-transparent">
            <q-tab-panel name="general" class="q-px-none">
              <div class="section">
                <div class="settings-panel-grid q-mb-lg" data-testid="global-settings-close-behavior">
                  <SettingsPanel v-bind="settingsHelp.closeBehavior" @request-help="openSettingsHelp">
                    <q-select
                      v-model="localConfig.general.closeBehavior"
                      label="关闭窗口行为"
                      emit-value
                      map-options
                      outlined
                      dense
                      :options="closeBehaviorOptions"
                    />
                  </SettingsPanel>
                  <SettingsPanel v-bind="settingsHelp.confirmBeforeQuit" @request-help="openSettingsHelp">
                    <div class="settings-toggle-control">
                      <span>{{ localConfig.general.confirmBeforeQuit ? "已启用" : "已关闭" }}</span>
                      <q-toggle
                        v-model="localConfig.general.confirmBeforeQuit"
                        color="primary"
                        aria-label="退出前确认"
                      />
                    </div>
                  </SettingsPanel>
                </div>

                <div class="row items-center q-mb-md settings-section-heading">
                  <div>
                    <div class="text-subtitle1 text-weight-medium">快捷键配置</div>
                    <div class="text-caption text-grey-7">
                      仅在对应模块页面、且焦点不在输入框时生效。
                    </div>
                  </div>
                  <q-space />
                  <q-btn
                    flat
                    round
                    dense
                    icon="help_outline"
                    class="settings-help-button"
                    aria-label="查看快捷键配置说明"
                    data-testid="settings-help-shortcuts"
                    @click="openSettingsHelp('shortcuts')"
                  />
                  <q-btn outline color="primary" icon="restart_alt" label="恢复全部默认" @click="restoreAllShortcutDefaults" />
                </div>

                <q-banner rounded class="settings-info-banner q-mb-md">
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
                      <q-btn
                        outline
                        no-caps
                        color="primary"
                        icon="fiber_manual_record"
                        :label="recordingShortcutId === definition.id ? '停止录制' : '录制'"
                        class="settings-action-button"
                        @click="toggleShortcutRecording(definition.id)"
                      />
                      <q-btn
                        outline
                        no-caps
                        color="primary"
                        icon="restart_alt"
                        label="恢复默认"
                        class="settings-action-button"
                        @click="restoreShortcutDefault(definition.id)"
                      />
                    </div>
                  </div>
                </div>

                <q-banner v-for="error in shortcutErrors" :key="error" rounded class="settings-warning-banner q-mb-sm">
                  {{ error }}
                </q-banner>
              </div>
            </q-tab-panel>

            <q-tab-panel
              name="backend"
              class="q-px-none"
              data-testid="global-settings-backend-panel"
            >
              <div class="section settings-panel-grid settings-panel-grid--service">
                <SettingsPanel v-bind="settingsHelp.backendPort" @request-help="openSettingsHelp">
                  <q-input
                    v-model.number="localConfig.general.backendPort"
                    label="服务端口"
                    type="number"
                    :min="1024"
                    :max="65535"
                    :step="1"
                    outlined
                    dense
                    :error="portError"
                    :error-message="portErrorMessage"
                    data-testid="global-settings-backend-port"
                    @update:model-value="validatePort"
                  />
                </SettingsPanel>
                <SettingsPanel v-bind="settingsHelp.launchMode" @request-help="openSettingsHelp">
                  <q-select
                    v-model="localConfig.general.launchMode"
                    label="启动方式"
                    emit-value
                    map-options
                    outlined
                    dense
                    :options="launchModeOptions"
                  />
                </SettingsPanel>
                <SettingsPanel v-bind="settingsHelp.backendProjectPath" @request-help="openSettingsHelp">
                  <template #actions>
                    <q-btn
                      round
                      dense
                      flat
                      icon="content_copy"
                      class="settings-copy-button"
                      aria-label="复制服务项目路径"
                      :disable="!localConfig.general.backendProjectPath"
                      @click="copyManagedPath(localConfig.general.backendProjectPath, '服务项目路径')"
                    >
                      <q-tooltip>复制路径</q-tooltip>
                    </q-btn>
                  </template>
                  <q-input v-model="localConfig.general.backendProjectPath" label="服务项目路径" outlined dense readonly>
                    <q-tooltip v-if="localConfig.general.backendProjectPath">
                      {{ localConfig.general.backendProjectPath }}
                    </q-tooltip>
                    <template #append>
                      <q-btn round dense flat icon="folder_open" class="settings-icon-button" aria-label="选择服务项目路径" @click="selectBackendProjectPath">
                        <q-tooltip>选择路径</q-tooltip>
                      </q-btn>
                    </template>
                  </q-input>
                </SettingsPanel>
                <SettingsPanel v-bind="settingsHelp.runtimeEnvironmentPath" @request-help="openSettingsHelp">
                  <template #actions>
                    <q-btn
                      round
                      dense
                      flat
                      icon="content_copy"
                      class="settings-copy-button"
                      aria-label="复制运行环境路径"
                      :disable="!runtimeEnvironmentPath"
                      @click="copyRuntimeEnvironmentPath"
                    >
                      <q-tooltip>复制路径</q-tooltip>
                    </q-btn>
                  </template>
                  <q-input
                    :model-value="runtimeEnvironmentPath"
                    label="运行环境路径"
                    outlined
                    dense
                    readonly
                    data-testid="global-settings-runtime-path"
                  >
                    <q-tooltip v-if="runtimeEnvironmentPath">{{ runtimeEnvironmentPath }}</q-tooltip>
                    <template #append>
                      <q-btn
                        round
                        dense
                        flat
                        icon="folder_open"
                        class="settings-icon-button"
                        aria-label="打开运行环境路径"
                        :disable="!runtimeEnvironmentPath"
                        @click="openRuntimeEnvironmentPath"
                      >
                        <q-tooltip>打开路径</q-tooltip>
                      </q-btn>
                    </template>
                  </q-input>
                </SettingsPanel>
                <SettingsPanel v-bind="settingsHelp.modelDir" @request-help="openSettingsHelp">
                  <template #actions>
                    <q-btn
                      round
                      dense
                      flat
                      icon="content_copy"
                      class="settings-copy-button"
                      aria-label="复制模型路径"
                      :disable="!localConfig.general.modelDir"
                      @click="copyManagedPath(localConfig.general.modelDir, '模型路径')"
                    >
                      <q-tooltip>复制路径</q-tooltip>
                    </q-btn>
                  </template>
                  <q-input v-model="localConfig.general.modelDir" label="模型路径" outlined dense readonly>
                    <q-tooltip v-if="localConfig.general.modelDir">
                      {{ localConfig.general.modelDir }}
                    </q-tooltip>
                    <template #append>
                      <q-btn round dense flat icon="folder_open" class="settings-icon-button" aria-label="选择模型路径" @click="selectModelPath">
                        <q-tooltip>选择路径</q-tooltip>
                      </q-btn>
                    </template>
                  </q-input>
                </SettingsPanel>
                <SettingsPanel v-bind="settingsHelp.defaultModel" @request-help="openSettingsHelp">
                  <q-select
                    v-model="localConfig.general.defaultModel"
                    label="默认模型"
                    emit-value
                    map-options
                    outlined
                    dense
                    :options="defaultBackendModelOptions"
                  />
                </SettingsPanel>
              </div>
            </q-tab-panel>

            <q-tab-panel name="models" class="q-px-none">
              <model-management-panel
                :backend-running="backendRunning"
                :selected-model-id="selectedModelId"
                @update:selected-model-id="selectedModelId = $event"
                @open-backend-manager="$emit('open-backend-manager')"
                @model-downloaded="handleModelDownloaded"
                @default-sam-model-updated="handleDefaultSamModelUpdated"
              />
            </q-tab-panel>

            <q-tab-panel name="files" class="q-px-none">
              <div class="section q-gutter-md">
                <div class="settings-panel-grid settings-panel-grid--file-management">
                  <SettingsPanel v-bind="settingsHelp.downloadPath" @request-help="openSettingsHelp">
                    <template #actions>
                      <q-btn
                        round
                        dense
                        flat
                        icon="content_copy"
                        class="settings-copy-button"
                        aria-label="复制下载或导出路径"
                        :disable="!localConfig.fileManagement.downloadPath"
                        @click="copyManagedPath(localConfig.fileManagement.downloadPath, '下载 / 导出路径')"
                      >
                        <q-tooltip>复制路径</q-tooltip>
                      </q-btn>
                    </template>
                    <q-input v-model="localConfig.fileManagement.downloadPath" label="下载 / 导出路径" outlined dense readonly>
                      <q-tooltip v-if="localConfig.fileManagement.downloadPath">
                        {{ localConfig.fileManagement.downloadPath }}
                      </q-tooltip>
                      <template #append>
                        <q-btn round dense flat icon="folder_open" class="settings-icon-button" aria-label="选择下载或导出路径" @click="selectDownloadPath">
                          <q-tooltip>选择路径</q-tooltip>
                        </q-btn>
                      </template>
                    </q-input>
                  </SettingsPanel>
                  <SettingsPanel v-bind="settingsHelp.tempPath" @request-help="openSettingsHelp">
                    <template #actions>
                      <q-btn
                        round
                        dense
                        flat
                        icon="content_copy"
                        class="settings-copy-button"
                        aria-label="复制临时文件路径"
                        :disable="!localConfig.fileManagement.tempPath"
                        @click="copyManagedPath(localConfig.fileManagement.tempPath, '临时文件路径')"
                      >
                        <q-tooltip>复制路径</q-tooltip>
                      </q-btn>
                    </template>
                    <q-input v-model="localConfig.fileManagement.tempPath" label="临时文件路径" outlined dense readonly>
                      <q-tooltip v-if="localConfig.fileManagement.tempPath">
                        {{ localConfig.fileManagement.tempPath }}
                      </q-tooltip>
                      <template #append>
                        <q-btn round dense flat icon="folder_open" class="settings-icon-button" aria-label="选择临时文件路径" @click="selectTempPath">
                          <q-tooltip>选择路径</q-tooltip>
                        </q-btn>
                      </template>
                    </q-input>
                  </SettingsPanel>
                  <SettingsPanel v-bind="settingsHelp.imageFolderName" @request-help="openSettingsHelp">
                    <q-input v-model="localConfig.fileManagement.imageFolderName" label="图片输出文件夹名" outlined dense />
                  </SettingsPanel>
                  <SettingsPanel v-bind="settingsHelp.videoFolderName" @request-help="openSettingsHelp">
                    <q-input v-model="localConfig.fileManagement.videoFolderName" label="视频输出文件夹名" outlined dense />
                  </SettingsPanel>
                </div>

                <SettingsPanel v-bind="settingsHelp.tempCleanup" @request-help="openSettingsHelp">
                  <div class="cleanup-row">
                    <div class="cleanup-copy">
                      <div class="text-caption text-grey-7">
                        清理配置临时路径下的图片和视频中间文件，最近失败现场可按需保留。
                      </div>
                    </div>
                    <q-btn
                      color="primary"
                      outline
                      no-caps
                      icon="cleaning_services"
                      label="立即清理"
                      class="settings-action-button cleanup-button"
                      data-testid="global-settings-cleanup-temp-files-button"
                      :loading="cleaningTempFiles"
                      :disable="isTempCleanupDisabled"
                      @click="cleanupAppTempFilesNow"
                    />
                  </div>

                  <div class="settings-toggle-grid q-mt-md">
                    <div class="startup-preference startup-preference--compact">
                      <div class="startup-preference-label">允许自动清理</div>
                      <q-toggle
                        v-model="localConfig.fileManagement.tempCleanup.enabled"
                        color="primary"
                        data-testid="global-settings-temp-cleanup-enabled"
                      />
                    </div>
                    <div class="startup-preference startup-preference--compact">
                      <div class="startup-preference-label">应用启动时执行</div>
                      <q-toggle
                        v-model="localConfig.fileManagement.tempCleanup.onStartup"
                        color="primary"
                        data-testid="global-settings-temp-cleanup-on-startup"
                      />
                    </div>
                    <div class="startup-preference startup-preference--compact">
                      <div class="startup-preference-label">清理图片临时文件</div>
                      <q-toggle
                        v-model="localConfig.fileManagement.tempCleanup.includeImages"
                        color="primary"
                        data-testid="global-settings-temp-cleanup-include-images"
                      />
                    </div>
                    <div class="startup-preference startup-preference--compact">
                      <div class="startup-preference-label">清理视频临时文件</div>
                      <q-toggle
                        v-model="localConfig.fileManagement.tempCleanup.includeVideos"
                        color="primary"
                        data-testid="global-settings-temp-cleanup-include-videos"
                      />
                    </div>
                    <div class="startup-preference startup-preference--compact">
                      <div class="startup-preference-label">保留最近失败现场</div>
                      <q-toggle
                        v-model="localConfig.fileManagement.tempCleanup.keepRecentFailures"
                        color="primary"
                        data-testid="global-settings-temp-cleanup-keep-recent-failures"
                      />
                    </div>
                    <q-input
                      v-model.number="localConfig.fileManagement.tempCleanup.maxAgeDays"
                      label="保留天数"
                      type="number"
                      :min="1"
                      :max="365"
                      :step="1"
                      suffix="天"
                      outlined
                      dense
                      data-testid="global-settings-temp-cleanup-max-age-days"
                    />
                    <q-input
                      v-model.number="localConfig.video.failureRetentionCount"
                      label="视频失败现场保留数量"
                      type="number"
                      :min="1"
                      :max="50"
                      :step="1"
                      suffix="个"
                      outlined
                      dense
                      data-testid="global-settings-video-failure-retention-count"
                    />
                  </div>
                </SettingsPanel>
              </div>
            </q-tab-panel>

            <q-tab-panel name="appearance" class="q-px-none">
              <div class="section q-gutter-lg">
                <div class="startup-preferences-row">
                  <SettingsPanel v-bind="settingsHelp.startupAnimation" @request-help="openSettingsHelp">
                    <div class="settings-toggle-control">
                      <span>{{ localConfig.ui.showStartupAnimation ? "已启用" : "已关闭" }}</span>
                      <q-toggle
                        v-model="localConfig.ui.showStartupAnimation"
                        color="primary"
                        aria-label="启动动画"
                      />
                    </div>
                  </SettingsPanel>
                  <SettingsPanel v-bind="settingsHelp.autoStart" @request-help="openSettingsHelp">
                    <div class="settings-toggle-control">
                      <span>{{ localConfig.general.autoStart ? "已启用" : "已关闭" }}</span>
                      <q-toggle
                        v-model="localConfig.general.autoStart"
                        color="primary"
                        aria-label="自动启动服务"
                      />
                    </div>
                  </SettingsPanel>
                </div>

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
                        <input
                          v-model="localConfig.ui.brandColors[item.key]"
                          type="color"
                          class="native-color-input"
                          :aria-label="`${item.label}颜色选择器`"
                        />
                        <q-input v-model="localConfig.ui.brandColors[item.key]" dense outlined :label="item.key" />
                      </div>
                      <p
                        class="settings-inline-description"
                        :data-testid="`settings-help-theme-${item.key}`"
                      >
                        {{ item.description }}
                      </p>
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
                  <div class="text-caption text-grey-7 q-mt-sm">
                    {{ settingsHelp.buttonSize.description }}
                  </div>
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
                      </div>
                      <div class="brush-default-preview" :aria-label="`${item.label}预览`">
                        <span class="brush-default-preview__dot" :style="getBrushPreviewStyle(item.key)"></span>
                      </div>
                      <div class="brush-default-controls q-mt-md">
                        <div class="color-row">
                          <span class="brush-control-label">画笔颜色</span>
                          <input
                            v-model="localConfig.advanced[item.key].color"
                            type="color"
                            class="native-color-input"
                            :aria-label="`${item.label}颜色选择器`"
                          />
                          <span class="brush-control-value brush-control-value--color">{{ getBrushConfig(item.key).color.toUpperCase() }}</span>
                        </div>
                        <div class="brush-control-field">
                          <div class="brush-control-header">
                            <span>画笔大小</span>
                            <span class="brush-control-value">{{ Math.round(getBrushConfig(item.key).size) }} px</span>
                          </div>
                          <q-slider v-model="localConfig.advanced[item.key].size" :min="1" :max="120" :step="1" :aria-label="`${item.label}画笔大小`" />
                        </div>
                        <div class="brush-control-field">
                          <div class="brush-control-header">
                            <span>画笔透明度</span>
                            <span class="brush-control-value">{{ formatBrushAlpha(getBrushConfig(item.key).alpha) }}</span>
                          </div>
                          <q-slider v-model="localConfig.advanced[item.key].alpha" :min="0.05" :max="1" :step="0.05" :aria-label="`${item.label}画笔透明度`" />
                        </div>
                      </div>
                      <div class="text-caption text-grey-7 q-mt-sm">{{ item.description }}</div>
                    </div>
                  </div>
                </div>
              </div>
            </q-tab-panel>

            <q-tab-panel name="image" class="q-px-none">
              <div class="section">
                    <div class="q-gutter-lg">
                      <div class="settings-panel-grid settings-panel-grid--image-core">
                        <SettingsPanel v-bind="settingsHelp.imageHistoryLimit" @request-help="openSettingsHelp">
                          <q-input
                            v-model.number="localConfig.advanced.imageHistoryLimit"
                            label="图片历史记录上限"
                            type="number"
                            :min="1"
                            :max="100"
                            :step="1"
                            outlined
                            dense
                          />
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.imageWarningSize" @request-help="openSettingsHelp">
                          <q-input
                            v-model.number="localConfig.advanced.imageWarningSize"
                            label="图片警告大小（MB）"
                            type="number"
                            :min="1"
                            :max="1000"
                            :step="1"
                            outlined
                            dense
                          />
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.stateSaveLimit" @request-help="openSettingsHelp">
                          <q-input
                            v-model.number="localConfig.advanced.stateSaveLimit"
                            label="状态保存上限大小（MB）"
                            type="number"
                            :min="10"
                            :max="500"
                            :step="1"
                            outlined
                            dense
                          />
                        </SettingsPanel>
                      <SettingsPanel v-bind="settingsHelp.imageProcessingMethod" @request-help="openSettingsHelp">
                        <q-select v-model="localConfig.advanced.imageProcessingMethod" :options="imageProcessingOptions" emit-value map-options outlined dense :disable="!canChangeImageProcessingMethod" />
                        <div v-if="!canChangeImageProcessingMethod" class="text-caption text-orange q-mt-xs">当前已有图片载入，暂时不能切换处理方式。</div>
                        <template #description>{{ getImageProcessingHint() }}</template>
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.slbrLocalInference" @request-help="openSettingsHelp">
                        <q-select
                          v-model="localConfig.advanced.slbrLocalInferenceStrategy"
                          label="SLBR 局部推理策略"
                          :options="slbrLocalInferenceStrategyOptions"
                          emit-value
                          map-options
                          outlined
                          dense
                          data-testid="global-settings-slbr-local-strategy"
                        />
                        <template #description>{{ getSlbrLocalInferenceHint() }}</template>
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.slbrLocalBBox" @request-help="openSettingsHelp">
                        <q-input
                          v-model.number="localConfig.advanced.slbrLocalBBoxEmptyRatioThreshold"
                          label="SLBR 局部外接矩形空白率阈值（%）"
                          type="number"
                          :min="1"
                          :max="99"
                          :step="1"
                          outlined
                          dense
                          data-testid="global-settings-slbr-local-empty-ratio"
                        />
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.slbrLocalEdgeFeather" @request-help="openSettingsHelp">
                        <q-input
                          v-model.number="localConfig.advanced.slbrLocalEdgeFeatherPx"
                          label="SLBR 局部边缘融合（px）"
                          type="number"
                          :min="0"
                          :max="16"
                          :step="1"
                          outlined
                          dense
                          data-testid="global-settings-slbr-local-edge-feather"
                        />
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.imageSmartSelectionModel" @request-help="openSettingsHelp">
                        <q-select
                          v-model="localConfig.masking.imageSmartSelectionDefaultModel"
                          label="图片处理页默认智能选区模型"
                          :options="imageSamDefaultModelOptions"
                          emit-value
                          map-options
                          options-dense
                          outlined
                          dense
                          data-testid="global-settings-image-sam-default-model"
                        />
                        <template #description>{{ imageSmartSelectionModelDescription }}</template>
                      </SettingsPanel>
                      </div>

                      <SettingsPanel
                        v-bind="settingsHelp.samRenderCache"
                        aria-label="智能选区渲染缓存"
                        @request-help="openSettingsHelp"
                      >
                        <div class="grid">
                          <q-toggle
                            v-model="localConfig.masking.samRenderCacheEnabled"
                            label="启用渲染缓存"
                            data-testid="global-settings-sam-render-cache-enabled"
                          />
                          <q-toggle
                            v-model="localConfig.masking.samLazyRenderDisabledCandidates"
                            label="未启用候选懒渲染"
                            data-testid="global-settings-sam-lazy-render-disabled-candidates"
                          />
                          <q-toggle
                            v-model="localConfig.masking.samRenderCachePreloadVisibleList"
                            label="预热左栏可见图片"
                            data-testid="global-settings-sam-preload-visible-list"
                          />
                          <q-toggle
                            v-model="localConfig.masking.samReleaseBeforeProcessing"
                            label="处理模型运行前释放 SAM 显存"
                            data-testid="global-settings-sam-release-before-processing"
                          />
                        </div>
                        <div class="text-caption text-grey-7 q-mt-xs">
                          开启后，连续智能选区仍会保留 SAM 缓存；运行 LaMa、MAT、SLBR 或视频处理前会释放 SAM 模型显存。
                        </div>
                        <div class="grid q-mt-sm">
                          <q-input
                            v-model.number="localConfig.masking.samRenderCacheMaxContexts"
                            label="最近图片缓存数量"
                            type="number"
                            :min="1"
                            :max="50"
                            :step="1"
                            dense
                            outlined
                            data-testid="global-settings-sam-render-cache-max-contexts"
                          />
                          <q-input
                            v-model.number="localConfig.masking.samRenderCacheMaxMemoryMb"
                            label="缓存内存上限（MB）"
                            type="number"
                            :min="32"
                            :max="1024"
                            :step="1"
                            dense
                            outlined
                            data-testid="global-settings-sam-render-cache-max-memory"
                          />
                          <q-input
                            v-model.number="localConfig.masking.samRenderCacheLargeImageLongSide"
                            label="大图长边阈值"
                            type="number"
                            :min="1024"
                            :max="12000"
                            :step="1"
                            dense
                            outlined
                            data-testid="global-settings-sam-render-cache-large-side"
                          />
                          <q-input
                            v-model.number="localConfig.masking.samRenderCacheNeighborPreloadCount"
                            label="相邻图片预热数量"
                            type="number"
                            :min="0"
                            :max="10"
                            :step="1"
                            dense
                            outlined
                            data-testid="global-settings-sam-neighbor-preload-count"
                          />
                        </div>
                        <div class="text-caption text-grey-7 q-mt-xs">
                          缓存仅保存在当前程序会话中，用于减少多图切换时 SAM 蒙版重新渲染等待；超过数量、内存或大图阈值后会自动淘汰，不影响原始候选数据。
                        </div>
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.imageOutput" @request-help="openSettingsHelp">
                        <div class="grid">
                          <q-select
                            v-model="localConfig.advanced.imageOutputFormat"
                            label="输出格式"
                            :options="imageOutputFormatOptions"
                            emit-value
                            map-options
                            outlined
                            dense
                          />
                          <q-input
                            v-model.number="localConfig.advanced.imageOutputQuality"
                            label="JPG / WebP 输出质量"
                            type="number"
                            :min="1"
                            :max="100"
                            :step="1"
                            outlined
                            dense
                          />
                        </div>
                        <template #description>{{ getImageOutputFormatHint() }}</template>
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.imageOutputNaming" @request-help="openSettingsHelp">
                        <q-btn-toggle v-model="localConfig.advanced.imageOutputNamingMode" spread unelevated toggle-color="primary" :color="$q.dark.isActive ? 'grey-9' : 'grey-3'" :text-color="$q.dark.isActive ? 'grey-2' : 'dark'" :options="imageNamingOptions" />
                        <q-input v-if="localConfig.advanced.imageOutputNamingMode === 'prefixUuid'" v-model.trim="localConfig.advanced.imageOutputFixedPrefix" outlined label="固定前缀" class="q-mt-md" />
                      </SettingsPanel>
                    </div>

              </div>
            </q-tab-panel>

            <q-tab-panel name="video" class="q-px-none">
              <div class="section">
                    <div class="q-gutter-lg">
                      <SettingsPanel v-bind="settingsHelp.videoProcessingEngine" @request-help="openSettingsHelp">
                        <q-select
                          v-model="localConfig.advanced.videoProcessingEngine"
                          label="导出与封装引擎"
                          :options="videoProcessingEngineOptions"
                          emit-value
                          map-options
                          outlined
                          dense
                          data-testid="global-settings-video-processing-engine"
                        />
                        <template #description>{{ getVideoProcessingEngineHint() }}</template>
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.videoTemporalEnhancement" @request-help="openSettingsHelp">
                        <template #actions>
                          <q-btn
                            outline
                            dense
                            no-caps
                            color="primary"
                            icon="restart_alt"
                            label="恢复默认"
                            class="settings-action-button"
                            @click="resetVideoTemporalEnhancement"
                          />
                        </template>
                        <div class="settings-toggle-grid">
                          <div class="startup-preference startup-preference--compact">
                            <div class="startup-preference-label">启用增强</div>
                            <q-toggle
                              v-model="localConfig.video.temporalEnhancement.enabled"
                              color="primary"
                              data-testid="global-settings-video-temporal-enhancement-enabled"
                            />
                          </div>
                          <div class="startup-preference startup-preference--compact">
                            <div class="startup-preference-label">Mask 稳定</div>
                            <q-toggle
                              v-model="localConfig.video.temporalEnhancement.stabilizeMask"
                              color="primary"
                              :disable="!localConfig.video.temporalEnhancement.enabled"
                            />
                          </div>
                          <div class="startup-preference startup-preference--compact">
                            <div class="startup-preference-label">结果稳定</div>
                            <q-toggle
                              v-model="localConfig.video.temporalEnhancement.stabilizeResult"
                              color="primary"
                              :disable="!localConfig.video.temporalEnhancement.enabled"
                            />
                          </div>
                          <div class="startup-preference startup-preference--compact">
                            <div class="startup-preference-label">纹理缓存</div>
                            <q-toggle
                              v-model="localConfig.video.temporalEnhancement.textureCache"
                              color="primary"
                              :disable="!localConfig.video.temporalEnhancement.enabled"
                            />
                          </div>
                          <div class="startup-preference startup-preference--compact">
                            <div class="startup-preference-label">诊断日志</div>
                            <q-toggle
                              v-model="localConfig.video.temporalEnhancement.diagnostics"
                              color="primary"
                              :disable="!localConfig.video.temporalEnhancement.enabled"
                            />
                          </div>
                          <q-select
                            v-model="localConfig.video.temporalEnhancement.mode"
                            label="增强模式"
                            :options="videoTemporalEnhancementModeOptions"
                            emit-value
                            map-options
                            outlined
                            dense
                            :disable="!localConfig.video.temporalEnhancement.enabled"
                            data-testid="global-settings-video-temporal-enhancement-mode"
                          />
                        </div>
                        <div class="grid q-mt-sm">
                          <q-input
                            v-model.number="localConfig.video.temporalEnhancement.sceneChangeThreshold"
                            label="场景变化阈值"
                            type="number"
                            :min="0"
                            :max="1"
                            :step="0.01"
                            outlined
                            dense
                            :disable="!localConfig.video.temporalEnhancement.enabled"
                          />
                          <q-input
                            v-model.number="localConfig.video.temporalEnhancement.maskIouThreshold"
                            label="Mask IoU 下限"
                            type="number"
                            :min="0"
                            :max="1"
                            :step="0.01"
                            outlined
                            dense
                            :disable="!localConfig.video.temporalEnhancement.enabled"
                          />
                          <q-input
                            v-model.number="localConfig.video.temporalEnhancement.centerShiftThreshold"
                            label="中心位移上限"
                            type="number"
                            :min="0"
                            :max="1"
                            :step="0.01"
                            outlined
                            dense
                            :disable="!localConfig.video.temporalEnhancement.enabled"
                          />
                          <q-input
                            v-model.number="localConfig.video.temporalEnhancement.blendStrength"
                            label="融合强度"
                            type="number"
                            :min="0"
                            :max="1"
                            :step="0.01"
                            outlined
                            dense
                            :disable="!localConfig.video.temporalEnhancement.enabled"
                          />
                          <q-input
                            v-model.number="localConfig.video.temporalEnhancement.cacheTtlFrames"
                            label="缓存寿命（帧）"
                            type="number"
                            :min="1"
                            :max="120"
                            :step="1"
                            outlined
                            dense
                            :disable="!localConfig.video.temporalEnhancement.enabled"
                          />
                          <q-input
                            v-model.number="localConfig.video.temporalEnhancement.minMaskArea"
                            label="最小 Mask 面积"
                            type="number"
                            :min="1"
                            :max="1000000"
                            :step="1"
                            outlined
                            dense
                            :disable="!localConfig.video.temporalEnhancement.enabled"
                          />
                        </div>
                      </SettingsPanel>

                      <SettingsPanel v-bind="settingsHelp.videoSmartSelectionModel" @request-help="openSettingsHelp">
                        <q-select
                          v-model="localConfig.masking.videoSmartSelectionDefaultModel"
                          label="视频处理页默认智能选区模型"
                          :options="videoSamDefaultModelOptions"
                          emit-value
                          map-options
                          options-dense
                          outlined
                          dense
                          data-testid="global-settings-video-sam-default-model"
                        />
                      </SettingsPanel>

                      <div class="settings-panel-grid">
                        <SettingsPanel v-bind="settingsHelp.videoBatchFrameCount" @request-help="openSettingsHelp">
                          <q-input
                            v-model.number="localConfig.video.batchFrameCount"
                            label="固定批次帧数"
                            type="number"
                            :min="1"
                            :step="1"
                            outlined
                            dense
                          />
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.videoIntermediateFrameStrategy" @request-help="openSettingsHelp">
                          <q-select
                            v-model="localConfig.video.intermediateFrameStrategy"
                            label="视频中间帧策略"
                            emit-value
                            map-options
                            outlined
                            dense
                            :options="videoIntermediateFrameStrategyOptions"
                            data-testid="global-settings-video-intermediate-frame-strategy"
                          />
                          <template #description>{{ getVideoIntermediateFrameStrategyHint() }}</template>
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.videoEncodingQuality" @request-help="openSettingsHelp">
                          <q-select
                            v-model="localConfig.video.encodingQualityPreset"
                            label="视频编码质量"
                            emit-value
                            map-options
                            outlined
                            dense
                            :options="videoEncodingQualityPresetOptions"
                            data-testid="global-settings-video-encoding-quality-preset"
                          />
                          <template #description>{{ getVideoEncodingQualityPresetHint() }}</template>
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.videoColorStabilization" @request-help="openSettingsHelp">
                          <q-select
                            v-model="localConfig.video.inpaintColorStabilization"
                            label="补洞颜色稳定"
                            emit-value
                            map-options
                            outlined
                            dense
                            :options="videoInpaintColorStabilizationOptions"
                            data-testid="global-settings-video-inpaint-color-stabilization"
                          />
                          <template #description>{{ getVideoInpaintColorStabilizationHint() }}</template>
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.videoHistoryLimit" @request-help="openSettingsHelp">
                          <q-input
                            v-model.number="localConfig.video.historyLimit"
                            label="视频历史记录上限"
                            type="number"
                            :min="1"
                            :max="50"
                            :step="1"
                            outlined
                            dense
                          />
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.videoBatchRetryCount" @request-help="openSettingsHelp">
                          <q-input
                            v-model.number="localConfig.video.batchRetryCount"
                            label="批次重试次数"
                            type="number"
                            :min="1"
                            :max="10"
                            :step="1"
                            outlined
                            dense
                          />
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.videoProxyMaxSide" @request-help="openSettingsHelp">
                          <q-input
                            v-model.number="localConfig.video.proxyMaxSide"
                            label="代理预览最大边长"
                            type="number"
                            :min="256"
                            :max="4096"
                            :step="1"
                            outlined
                            dense
                          />
                        </SettingsPanel>
                        <SettingsPanel v-bind="settingsHelp.previewTrialSeconds" @request-help="openSettingsHelp">
                          <q-select
                            v-model="localConfig.video.previewTrialSeconds"
                            label="样片试跑时长"
                            emit-value
                            map-options
                            outlined
                            dense
                            :options="previewTrialOptions"
                          />
                        </SettingsPanel>
                      </div>
                    </div>

              </div>
            </q-tab-panel>

            <q-tab-panel name="updates" class="q-px-none" data-testid="global-settings-updates-panel">
              <div class="section q-gutter-md">
                <div class="row items-center settings-section-heading">
                  <div>
                    <div class="text-subtitle1 text-weight-medium">应用更新</div>
                    <div class="text-caption text-grey-7">
                      {{ updateChannelLabel }}通道 · 当前版本 {{ updateManager.state.currentVersion || "未知" }}
                    </div>
                  </div>
                  <q-space />
                  <q-badge :color="updateStatusColor" data-testid="global-settings-update-status">
                    {{ updateManager.statusLabel }}
                  </q-badge>
                </div>

                <q-banner
                  v-if="updateManager.state.error"
                  rounded
                  class="settings-warning-banner"
                  data-testid="global-settings-update-error"
                >
                  {{ updateManager.state.error.message }}
                </q-banner>

                <div class="block update-panel-block update-panel-block--app">
                  <div class="row items-center q-gutter-xs q-mb-md text-caption text-grey-7" data-testid="global-settings-update-channel">
                    <q-icon name="lock" size="16px" />
                    <span>更新通道：{{ updateChannelLabel }}（{{ updateEditionLabel }}，已锁定）</span>
                  </div>
                  <div class="update-status-hero" data-testid="global-settings-update-summary">
                    <div class="update-status-hero__icon" :class="`update-status-hero__icon--${updateStatusColor}`">
                      <q-icon :name="updateStatusIcon" size="22px" />
                    </div>
                    <div class="update-status-hero__copy">
                      <div class="update-status-hero__eyebrow">应用版本</div>
                      <div class="update-status-hero__title">{{ updateStatusSummary }}</div>
                    </div>
                    <q-space />
                    <q-btn
                      v-if="showCheckUpdateAction"
                      outline
                      no-caps
                      color="primary"
                      icon="refresh"
                      :label="updateManager.retryAction === 'check' ? '重新检查' : '检查更新'"
                      :loading="updateManager.isChecking"
                      :disable="!updateManager.canCheck"
                      data-testid="global-settings-update-check"
                      @click="handleCheckForUpdates"
                    />
                  </div>

                  <div class="update-meta-grid q-mt-md" aria-label="应用更新状态详情">
                    <div class="update-meta-item">
                      <q-icon name="verified" size="16px" />
                      <div>
                        <div class="update-meta-item__label">当前版本</div>
                        <div class="update-meta-item__value">{{ updateManager.state.currentVersion || "未知" }}</div>
                      </div>
                    </div>
                    <div class="update-meta-item">
                      <q-icon name="history" size="16px" />
                      <div>
                        <div class="update-meta-item__label">当前版本更新时间</div>
                        <div class="update-meta-item__value">{{ currentVersionUpdatedAtText }}</div>
                      </div>
                    </div>
                    <div class="update-meta-item">
                      <q-icon name="schedule" size="16px" />
                      <div>
                        <div class="update-meta-item__label">上次检查</div>
                        <div class="update-meta-item__value">{{ lastUpdateCheckedAtText }}</div>
                      </div>
                    </div>
                    <div v-if="updateManager.state.availableVersion" class="update-meta-item">
                      <q-icon name="new_releases" size="16px" />
                      <div>
                        <div class="update-meta-item__label">可用版本发布日期</div>
                        <div class="update-meta-item__value">{{ availableReleaseDateText }}</div>
                      </div>
                    </div>
                  </div>

                  <div v-if="updateManager.isDownloading" class="q-mt-md">
                    <q-linear-progress
                      :value="Number(updateManager.state.progress || 0) / 100"
                      color="primary"
                      rounded
                    />
                    <div class="row items-center justify-between q-gutter-sm text-caption text-grey-7 q-mt-xs">
                      <span>已下载 {{ Math.round(Number(updateManager.state.progress || 0)) }}%</span>
                      <span v-if="updateTransferSummary">{{ updateTransferSummary }}</span>
                    </div>
                  </div>

                  <div v-if="showDownloadUpdateAction" class="row justify-end q-mt-md">
                    <q-btn
                      outline
                      no-caps
                      color="primary"
                      icon="download"
                      :label="updateManager.retryAction === 'download' ? '重新下载' : '下载更新'"
                      :loading="updateManager.isDownloading"
                      :disable="!updateManager.canDownload"
                      data-testid="global-settings-update-download"
                      @click="handleDownloadUpdate"
                    />
                  </div>

                  <div v-if="showInstallUpdateAction" class="row justify-end q-mt-md">
                    <q-btn
                      color="primary"
                      no-caps
                      icon="system_update_alt"
                      :label="updateManager.retryAction === 'install' ? '重试安装' : '重启并安装'"
                      :loading="updateManager.isInstalling"
                      :disable="!updateManager.canInstall"
                      data-testid="global-settings-update-install"
                      @click="handleInstallUpdate"
                    />
                  </div>

                  <div v-if="updateManager.state.installBlockedReason" class="text-caption text-warning q-mt-sm">
                    {{ updateManager.state.installBlockedReason }}
                  </div>
                </div>

                <div v-if="updateManager.state.releaseNotes" class="block update-panel-block">
                  <div class="text-subtitle2 text-weight-medium q-mb-sm">版本说明</div>
                  <div class="text-body2 update-release-notes">{{ updateManager.state.releaseNotes }}</div>
                </div>

                <div class="block environment-update-card" data-testid="global-settings-environment-update">
                  <div class="environment-update-card__header">
                    <div class="row items-center no-wrap q-gutter-sm">
                      <div class="environment-update-card__icon">
                        <q-icon name="memory" size="20px" />
                      </div>
                      <div>
                        <div class="text-subtitle2 text-weight-medium">运行环境更新检测</div>
                        <div class="text-caption text-grey-7">检查当前环境版本与可用的 CPU / CUDA 切换方式</div>
                      </div>
                    </div>
                    <q-badge :color="runtimeEnvironmentUpdateBadgeColor" class="environment-update-card__status">
                      {{ runtimeEnvironmentUpdateStatusLabel }}
                    </q-badge>
                  </div>

                  <template v-if="runtimeEnvironmentUpdateUsable">
                    <div class="environment-update-metrics q-mt-md">
                      <div class="environment-update-metric">
                        <span>Python</span>
                        <strong>{{ runtimeEnvironmentUpdate.pythonVersion || "未提供" }}</strong>
                      </div>
                      <div class="environment-update-metric">
                        <span>PyTorch</span>
                        <strong>{{ runtimeEnvironmentTorchText }}</strong>
                      </div>
                      <div class="environment-update-metric">
                        <span>显卡</span>
                        <strong>{{ runtimeEnvironmentUpdate.gpuName || "未检测到 NVIDIA 显卡" }}</strong>
                      </div>
                      <div class="environment-update-metric">
                        <span>NVIDIA 驱动</span>
                        <strong>{{ runtimeEnvironmentUpdate.nvidiaDriverVersion || "未检测到" }}</strong>
                      </div>
                    </div>
                    <div class="environment-update-card__footer q-mt-md">
                      <div class="text-caption text-grey-7">
                        {{ runtimeEnvironmentUpdateCheckedAtText }}
                      </div>
                      <div class="row items-center q-gutter-sm">
                        <q-btn
                          v-if="runtimeEnvironmentUpdate.canSwitchToCpu"
                          outline
                          no-caps
                          color="primary"
                          icon="settings_suggest"
                          label="切换为 CPU 运行环境"
                          :loading="runtimeEnvironmentSwitching"
                          @click="requestRuntimeEnvironmentSwitch('cpu')"
                        />
                        <q-btn
                          v-if="runtimeEnvironmentUpdate.canSwitchToCu130"
                          outline
                          no-caps
                          color="positive"
                          icon="bolt"
                          label="切换为 CUDA 运行环境"
                          :loading="runtimeEnvironmentSwitching"
                          @click="requestRuntimeEnvironmentSwitch('cu130')"
                        />
                        <q-btn
                          flat
                          dense
                          no-caps
                          color="primary"
                          icon="refresh"
                          label="重新检测"
                          :loading="runtimeEnvironmentChecking"
                          @click="refreshRuntimeEnvironmentUpdate"
                        />
                      </div>
                    </div>
                  </template>
                  <div v-else class="environment-update-empty q-mt-md">
                    <q-icon name="info" size="20px" />
                    <div>
                      <div class="text-body2 text-weight-medium">当前无可用运行环境</div>
                      <div class="text-caption text-grey-7">
                        {{ runtimeEnvironmentUpdateUnavailableMessage }}
                      </div>
                      <q-btn
                        v-if="runtimeEnvironmentIsReady"
                        flat
                        dense
                        no-caps
                        color="primary"
                        icon="refresh"
                        label="重新检测"
                        class="q-mt-sm"
                        :loading="runtimeEnvironmentChecking"
                        @click="refreshRuntimeEnvironmentUpdate"
                      />
                    </div>
                  </div>
                  <div v-if="runtimeEnvironmentUpdate.acceleratorChangeReason" class="environment-update-hint q-mt-sm">
                    <q-icon name="tips_and_updates" size="16px" />
                    <span>{{ runtimeEnvironmentUpdate.acceleratorChangeReason }}</span>
                  </div>
                </div>
              </div>
            </q-tab-panel>
            <q-tab-panel name="mcp" class="q-px-none" data-testid="global-settings-mcp-panel">
              <McpSettingsPanel
                :initial-tab="initialMcpTab"
                :navigation-key="navigationKey"
              />
            </q-tab-panel>
          </q-tab-panels>
          </q-scroll-area>
        </div>
      </q-card-section>

      <q-card-section v-if="validationErrors.length" class="q-pt-none q-pb-none">
        <q-banner rounded class="settings-warning-banner">
          <div v-for="error in validationErrors" :key="error">{{ error }}</div>
        </q-banner>
      </q-card-section>

      <q-card-actions align="right" class="settings-actions q-pa-md">
        <q-btn flat no-caps label="取消" v-close-popup />
        <q-btn
          outline
          no-caps
          color="primary"
          icon="save"
          label="保存"
          class="settings-action-button"
          data-testid="global-settings-save-button"
          :loading="saving"
          :disable="hasErrors"
          @click="saveSettings"
        />
      </q-card-actions>
    </q-card>
  </q-dialog>

  <q-dialog v-model="showSettingsHelpDialog" class="settings-help-dialog">
    <q-card class="settings-help-card" data-testid="settings-help-dialog">
      <q-card-section class="row items-center q-pb-none">
        <q-icon name="help_outline" color="primary" size="24px" />
        <div class="text-h6 q-ml-sm">{{ activeSettingsHelp.title }}</div>
        <q-space />
        <q-btn
          flat
          round
          dense
          icon="close"
          class="settings-icon-button"
          aria-label="关闭设置说明"
          v-close-popup
        />
      </q-card-section>
      <q-card-section>
        <p class="settings-help-summary">{{ activeSettingsHelp.description }}</p>
        <ul v-if="activeSettingsHelp.details?.length" class="settings-help-details">
          <li v-for="detail in activeSettingsHelp.details" :key="detail">{{ detail }}</li>
        </ul>
      </q-card-section>
      <q-card-actions align="right">
        <q-btn flat no-caps color="primary" label="知道了" v-close-popup />
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
import { computed, inject, onMounted, onUnmounted, ref, watch } from "vue";
import { copyToClipboard, useQuasar } from "quasar";
import ModelManagementPanel from "src/components/global/ModelManagementPanel.vue";
import McpSettingsPanel from "src/components/global/McpSettingsPanel.vue";
import SettingsPanel from "src/components/global/SettingsPanel.vue";
import { ConfigManager, DEFAULT_BRAND_COLORS, DEFAULT_IMAGE_BRUSH, DEFAULT_MASKING_CONFIG, DEFAULT_TEMP_CLEANUP, DEFAULT_UI_BUTTON_SIZE, DEFAULT_VIDEO_BRUSH, DEFAULT_VIDEO_TEMPORAL_ENHANCEMENT, SLBR_LOCAL_INFERENCE_STRATEGY_OPTIONS, UI_BUTTON_SIZE_OPTIONS, VIDEO_ENCODING_QUALITY_PRESET_OPTIONS, VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS, VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS, VIDEO_PROCESSING_ENGINE_OPTIONS, VIDEO_TEMPORAL_ENHANCEMENT_MODES } from "src/config/ConfigManager";
import { createDefaultShortcuts, formatShortcutKeys, getShortcutDefinition, getShortcutTokenFromKeyboardEvent, getShortcutsByGroup, normalizeShortcutKeys, SHORTCUT_GROUP_META, SHORTCUT_GROUPS, validateShortcutConfig } from "src/utils/shortcutConfig";
import { useAppStateStore } from "src/stores/appState";
import { useConfigStore } from "src/stores/config";
import { useFileManagerStore } from "src/stores/fileManager";
import { useModelRegistryStore } from "src/stores/modelRegistry";
import { useUpdateManagerStore } from "src/stores/updateManager";
import {
  buildBackendPathBlockedMessage,
  buildBackendPathWarningMessage,
  buildBackendPathSelectionBlockedMessage,
  validateBackendPaths,
} from "src/utils/backendPathValidation";

const $q = useQuasar();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const fileManagerStore = useFileManagerStore();
const modelRegistryStore = useModelRegistryStore();
const updateManager = useUpdateManagerStore();
const globalLoadingState = inject("globalLoadingState", ref({ showing: false }));
const updateChannelLabel = computed(() => ({
  stable: "稳定",
  beta: "测试候选",
  test: "测试",
}[updateManager.state.channel] || updateManager.state.channel || "稳定"));
const updateEditionLabel = computed(() => (updateManager.state.edition === "test" ? "测试版" : "正式版"));

const launchModeOptions = [{ label: "CUDA 加速", value: "cuda" }, { label: "CPU 模式", value: "cpu" }];
const closeBehaviorOptions = [
  { label: "最小化到托盘（推荐）", value: "tray" },
  { label: "退出程序", value: "quit" },
];
const MAT_CUDA_FALLBACK_MESSAGE = "MAT 需要 CUDA，当前已自动切换为 LaMa。";
const imageProcessingOptions = [
  {
    label: "自动（推荐）",
    value: "auto",
    description: "100 张以内、单张不超过图片警告大小且总量不超过 100MB 时使用 Base64，其他情况使用路径模式。",
  },
  {
    label: "文件路径",
    value: "path",
    description: "更适合大批量、本地路径和文件夹处理，前端内存压力更低。",
  },
  {
    label: "Base64",
    value: "base64",
    description: "小批量时可减少临时文件，但大量图片时更占内存。",
  },
];
const slbrLocalInferenceStrategyOptions = SLBR_LOCAL_INFERENCE_STRATEGY_OPTIONS.map((value) => ({
  value,
  label: {
    auto: "自动（推荐）",
    full: "整图推理后局部写回",
    smart_tiles: "智能局部 Tile",
  }[value] || value,
  description: {
    auto: "先排除外接矩形内空白过多的选区，再要求预计至少节省 15% Tile。",
    full: "按整图运行 SLBR，但只把结果写回蒙版内。",
    smart_tiles: "只运行覆盖局部外接矩形的规范 Tile，速度更快但结果可能与整图略有差异。",
  }[value] || "",
}));
const imageOutputFormatOptions = [
  { label: "自动（尽量保持原格式）", value: "auto", description: "根据原图格式与透明通道选择合适输出格式。" },
  { label: "保持原格式", value: "original", description: "尽量沿用原图扩展名与编码类型。" },
  { label: "PNG", value: "png", description: "无损输出，适合透明图，但文件通常更大。" },
  { label: "JPG", value: "jpg", description: "体积较小，透明图会使用白色背景合成。" },
  { label: "WebP", value: "webp", description: "压缩率较高，并支持透明通道。" },
];
const imageNamingOptions = [{ label: "原文件名", value: "original" }, { label: "固定前缀 + UUID", value: "prefixUuid" }];
const videoIntermediateFrameStrategyMeta = {
  performance: {
    label: "性能优先",
    description: "输入帧和结果帧使用高质量 JPG，配合 FFmpeg 色彩控制，临时文件更小、处理更快。",
  },
  balanced: {
    label: "均衡",
    description: "输入帧使用 JPG，结果帧使用 PNG，减少模型输出再次压缩导致的重复处理损失。",
  },
  quality: {
    label: "质量优先",
    description: "输入帧和结果帧都使用 PNG，中间损失最低，但临时文件更大、读写更慢。",
  },
};
const videoIntermediateFrameStrategyOptions = VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS.map((value) => ({
  value,
  label: videoIntermediateFrameStrategyMeta[value]?.label || value,
  description: videoIntermediateFrameStrategyMeta[value]?.description || "",
}));
const videoEncodingQualityPresetMeta = {
  performance: {
    label: "性能优先",
    description: "CRF 18，当前默认。编码速度和文件体积更友好，已配合 FFmpeg 色彩控制降低重复处理漂移。",
  },
  balanced: {
    label: "均衡",
    description: "CRF 14，亮度漂移约减半，输出体积通常约为性能优先的 1.9 倍。",
  },
  stable: {
    label: "稳定优先",
    description: "CRF 10，进一步压低重复处理漂移，输出体积通常约为性能优先的 3 倍以上。",
  },
  highStable: {
    label: "高稳定",
    description: "CRF 6，亮度漂移更低，输出体积通常约为性能优先的 5-6 倍。",
  },
  nearLossless: {
    label: "近无损",
    description: "CRF 2，接近无损编码，适合短片或关键素材，输出体积会显著增加。",
  },
};
const videoEncodingQualityPresetOptions = VIDEO_ENCODING_QUALITY_PRESET_OPTIONS.map((value) => ({
  value,
  label: videoEncodingQualityPresetMeta[value]?.label || value,
  description: videoEncodingQualityPresetMeta[value]?.description || "",
}));
const videoInpaintColorStabilizationMeta = {
  off: {
    label: "关闭",
    description: "完全保留模型原始补洞结果，适合排查模型差异。",
  },
  auto: {
    label: "自动（推荐）",
    description: "纯色或绿幕背景直接回填，普通区域做轻量局部颜色匹配，兼顾速度和稳定性。",
  },
  enhanced: {
    label: "增强",
    description: "放宽颜色匹配强度，用于明显色差素材；仍不启用高开销的无缝融合。",
  },
};
const videoInpaintColorStabilizationOptions = VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS.map((value) => ({
  value,
  label: videoInpaintColorStabilizationMeta[value]?.label || value,
  description: videoInpaintColorStabilizationMeta[value]?.description || "",
}));
const videoProcessingEngineOptionMeta = {
  auto: {
    label: "自动（推荐）",
    description: "优先使用 FFmpeg 保持视频颜色范围稳定；FFmpeg 不可用时自动切换 WebAV 兜底。",
  },
  webav: {
    label: "WebAV",
    description: "仅使用 WebAV，适合定位浏览器视频能力问题；失败时不会自动兜底。",
  },
  ffmpeg: {
    label: "FFmpeg",
    description: "直接使用内置 FFmpeg 完成导出与封装，绕开 WebCodecs 能力限制。",
  },
};
const videoProcessingEngineOptions = VIDEO_PROCESSING_ENGINE_OPTIONS.map((value) => ({
  value,
  label: videoProcessingEngineOptionMeta[value]?.label || value,
  description: videoProcessingEngineOptionMeta[value]?.description || "",
}));
const videoTemporalEnhancementModeMeta = {
  conservative: "保守",
  balanced: "均衡",
  strong: "强力",
};
const videoTemporalEnhancementModeOptions = VIDEO_TEMPORAL_ENHANCEMENT_MODES.map((value) => ({
  value,
  label: videoTemporalEnhancementModeMeta[value] || value,
}));
const previewTrialOptions = [{ label: "3 秒", value: 3 }, { label: "10 秒", value: 10 }];
const fallbackSamModels = [
  {
    id: DEFAULT_MASKING_CONFIG.defaultSam1Model,
    label: "SAM1 ViT-B",
    family: "sam",
    familyLabel: "SAM1",
    modelVersion: "SAM1",
    variant: "ViT-B",
  },
  {
    id: DEFAULT_MASKING_CONFIG.defaultSam2Model,
    label: "SAM2.1 Hiera Large",
    family: "sam2",
    familyLabel: "SAM2.1",
    modelVersion: "SAM2.1",
    variant: "Hiera Large",
  },
  {
    id: DEFAULT_MASKING_CONFIG.defaultSam3Model,
    label: "SAM3.1 Multiplex",
    family: "sam3",
    familyLabel: "SAM3.1",
    modelVersion: "SAM3.1",
    variant: "Multiplex",
  },
];
const themeColorFields = [
  { key: "primary", label: "Primary", description: "主要操作、选中状态和重点交互使用的品牌色。" },
  { key: "secondary", label: "Secondary", description: "次要操作与辅助界面元素使用的品牌色。" },
  { key: "accent", label: "Accent", description: "需要额外强调但不属于主操作的界面元素使用此颜色。" },
  { key: "positive", label: "Positive", description: "成功、完成和可用状态使用的反馈颜色。" },
  { key: "negative", label: "Negative", description: "错误、失败和高风险操作使用的反馈颜色。" },
  { key: "info", label: "Info", description: "一般信息、提示和处理中状态使用的反馈颜色。" },
  { key: "warning", label: "Warning", description: "警告、需注意和可能影响结果的状态使用此颜色。" },
];
const brushConfigFields = [
  { key: "imageBrushDefault", label: "图片默认画笔", description: "作为图片蒙版绘制工具首次打开时的颜色、大小和透明度。" },
  { key: "videoBrushDefault", label: "视频默认画笔", description: "作为视频蒙版绘制工具首次打开时的颜色、大小和透明度。" },
];
const buttonSizeOptions = UI_BUTTON_SIZE_OPTIONS.slice().reverse().map((value) => ({ label: value.toUpperCase(), value }));

const createSettingsHelp = (helpTopic, title, description, helpMode = "inline", details = []) =>
  Object.freeze({ helpTopic, title, description, helpMode, details });

const settingsHelp = Object.freeze({
  shortcuts: createSettingsHelp(
    "shortcuts",
    "快捷键配置",
    "快捷键只在对应功能页面且焦点不在输入框时生效。录制会按动作要求自动收集一至三个按键。",
    "dialog",
    [
      "按下“录制”后直接输入组合键；按 Esc 可随时取消本次录制。",
      "单键、双键和三键动作必须保持规定的按键数量。",
      "同一作用域内的重复组合会阻止保存，输入框获得焦点时不会触发页面快捷键。",
    ]
  ),
  closeBehavior: createSettingsHelp(
    "close-behavior",
    "关闭窗口行为",
    "最小化到托盘会保留当前窗口和任务；选择退出程序时会进入退出确认与停止流程。"
  ),
  confirmBeforeQuit: createSettingsHelp(
    "confirm-before-quit",
    "退出前确认",
    "退出前会确认正在处理的任务和运行环境准备操作。"
  ),
  backendPort: createSettingsHelp("backend-port", "服务端口", "本地服务监听的端口，修改后会重新加载页面以应用。"),
  launchMode: createSettingsHelp("launch-mode", "启动方式", "CUDA 模式优先使用显卡；CPU 模式兼容性更高，但处理速度通常较慢。"),
  backendProjectPath: createSettingsHelp("backend-project-path", "服务项目路径", "外部 Python 服务所在路径，应包含项目运行所需的完整文件。"),
  runtimeEnvironmentPath: createSettingsHelp("runtime-environment-path", "运行环境路径", "当前服务实际使用的 Python 运行环境。可复制或在资源管理器中打开；环境切换请在服务管理中完成。"),
  modelDir: createSettingsHelp("model-directory", "模型路径", "集中存放处理模型的路径，服务启动和模型管理会共同使用。"),
  defaultModel: createSettingsHelp("default-backend-model", "默认模型", "新建图片处理任务时优先选用的补洞模型。"),
  downloadPath: createSettingsHelp("download-path", "下载 / 导出路径", "图片和视频未指定其他位置时默认保存到此路径。"),
  tempPath: createSettingsHelp("temp-path", "临时文件路径", "处理过程中的帧、缓存和中间结果保存在此路径。"),
  imageFolderName: createSettingsHelp("image-folder-name", "图片输出文件夹名", "批量导出图片时在导出根路径下创建的单级文件夹。"),
  videoFolderName: createSettingsHelp("video-folder-name", "视频输出文件夹名", "批量导出视频时在导出根路径下创建的单级文件夹。"),
  tempCleanup: createSettingsHelp(
    "temp-cleanup",
    "临时文件清理",
    "按保留时间清理应用临时路径中的图片、视频中间文件和已完成任务现场。",
    "dialog",
    [
      "自动清理关闭时不会在启动阶段执行，但仍可使用“立即清理”。",
      "最近失败现场用于故障排查；启用保留后，仅删除超过保留数量的较旧现场。",
      "清理范围仅限应用管理的临时子路径，不会处理导出路径或其他任意位置。",
    ]
  ),
  startupAnimation: createSettingsHelp("startup-animation", "启动动画", "控制应用启动阶段是否显示过渡动画。"),
  autoStart: createSettingsHelp("auto-start-backend", "自动启动服务", "应用打开后自动准备并启动服务；关闭后可在主界面手动启动。"),
  buttonSize: createSettingsHelp("drawing-button-size", "绘制工具按钮大小", "调整图片和视频绘制工具按钮的默认尺寸，不改变画布或导出结果。"),
  imageHistoryLimit: createSettingsHelp("image-history-limit", "图片历史记录上限", "限制图片处理页可撤销和恢复的历史步骤数量。"),
  imageWarningSize: createSettingsHelp("image-warning-size", "图片警告大小", "单张图片超过该体积时提示资源占用风险，并影响自动传输策略。"),
  stateSaveLimit: createSettingsHelp("state-save-limit", "状态保存上限", "限制页面状态持久化体积，避免过大的会话数据拖慢保存与恢复。"),
  imageProcessingMethod: createSettingsHelp(
    "image-processing-method",
    "图片处理方式",
    "自动模式会按图片数量、单图体积和总量选择路径或 Base64；路径模式更节省内存，Base64 更适合少量小图。"
  ),
  slbrLocalInference: createSettingsHelp(
    "slbr-local-inference",
    "SLBR 局部推理",
    "局部结果始终保存为 PNG，避免 JPEG 再编码影响选区外像素。自动模式会先比较外接矩形空白率，再要求预计至少节省 15% Tile。"
  ),
  slbrLocalBBox: createSettingsHelp(
    "slbr-local-bbox-empty-ratio",
    "SLBR 局部空白率阈值",
    "以所有选区合并后的最小外接矩形计算。空白率达到此阈值时，自动模式改用整图推理后局部写回。"
  ),
  slbrLocalEdgeFeather: createSettingsHelp(
    "slbr-local-edge-feather",
    "SLBR 局部边缘融合",
    "仅在蒙版内部向内融合；不会修改蒙版外像素或不连续选区之间的空白区域。"
  ),
  imageSmartSelectionModel: createSettingsHelp(
    "image-smart-selection-model",
    "智能选区默认模型",
    "点选和框选模型包括 SAM1、SAM2.1 与标准 SAM3；SAM3.1 Multiplex 当前仅支持文本选取。"
  ),
  samRenderCache: createSettingsHelp(
    "sam-render-cache",
    "智能选区渲染缓存",
    "控制智能选区候选蒙版的会话缓存、预热与显存释放策略。",
    "dialog",
    [
      "渲染缓存只保存在当前程序会话中，不会修改或覆盖原始候选数据。",
      "数量、内存和大图阈值共同决定淘汰时机；相邻图片预热可减少连续切换等待。",
      "处理模型运行前释放 SAM 显存可降低显存不足风险，但下次智能选区需要重新加载模型。",
    ]
  ),
  imageOutput: createSettingsHelp(
    "image-output-format-quality",
    "图片输出格式与质量",
    "PNG 为无损格式；JPG 文件较小但不支持透明；WebP 兼顾压缩率与透明。质量参数只作用于 JPG 和 WebP。"
  ),
  imageOutputNaming: createSettingsHelp("image-output-naming", "图片输出命名方式", "可沿用原文件名，或使用固定前缀和 UUID 避免重名覆盖。"),
  videoProcessingEngine: createSettingsHelp(
    "video-processing-engine",
    "视频处理引擎",
    "自动模式按素材和环境选择导出方案；FFmpeg 兼容面更广，WebAV 可在支持的素材上减少额外中间转换。"
  ),
  videoTemporalEnhancement: createSettingsHelp(
    "video-temporal-enhancement",
    "视频处理增强",
    "通过相邻帧 Mask、结果和纹理信息减少视频补洞中的闪烁与边缘跳动。",
    "dialog",
    [
      "场景变化阈值用于在镜头切换时停止沿用旧缓存，避免跨场景污染。",
      "Mask IoU、中心位移和最小面积共同判断候选区域是否适合跨帧融合。",
      "融合强度越高，画面连续性通常越强，但快速运动场景可能保留更多上一帧特征。",
      "诊断日志仅用于本地排查增强过程，不会上传处理素材。",
    ]
  ),
  videoSmartSelectionModel: createSettingsHelp(
    "video-smart-selection-model",
    "智能选区默认模型",
    "视频智能选区依赖 SAM2.1 的跨帧传播能力，因此这里只列出可用于视频传播的 SAM2.1 型号。"
  ),
  videoBatchFrameCount: createSettingsHelp("video-batch-frame-count", "固定批次帧数", "每批帧数越大，处理吞吐可能更高，但同时占用更多内存和显存。"),
  videoIntermediateFrameStrategy: createSettingsHelp(
    "video-intermediate-frame-strategy",
    "视频中间帧策略",
    "性能优先使用较小的 JPG 中间帧，质量优先使用 PNG 降低重复压缩损失，均衡模式介于两者之间。"
  ),
  videoEncodingQuality: createSettingsHelp(
    "video-encoding-quality",
    "视频编码质量",
    "较高质量会降低重复编码造成的亮度和细节漂移，但编码时间、文件体积和磁盘读写都会增加。"
  ),
  videoColorStabilization: createSettingsHelp(
    "video-color-stabilization",
    "补洞颜色稳定",
    "在补洞区域与原视频之间校正颜色变化，可减少闪烁；强校正可能影响本来就快速变化的光照。"
  ),
  videoHistoryLimit: createSettingsHelp("video-history-limit", "视频历史记录上限", "限制视频编辑过程保留的撤销和恢复步骤数量。"),
  videoBatchRetryCount: createSettingsHelp("video-batch-retry-count", "批次重试次数", "单个视频批次失败后允许自动重新执行的最大次数。"),
  videoProxyMaxSide: createSettingsHelp("video-proxy-max-side", "代理预览最大边长", "限制预览代理的长边尺寸；较小更流畅，较大更便于观察细节。"),
  previewTrialSeconds: createSettingsHelp("preview-trial-seconds", "样片试跑时长", "视频处理页新任务默认截取的样片长度，可在实际试跑前临时调整。"),
});
const settingsHelpByTopic = Object.freeze(
  Object.fromEntries(Object.values(settingsHelp).map((item) => [item.helpTopic, item]))
);

const props = defineProps({
  modelValue: { type: Boolean, default: false },
  initialTab: { type: String, default: "" },
  initialModelId: { type: String, default: "" },
  initialMcpTab: { type: String, default: "settings" },
  navigationKey: { type: Number, default: 0 },
  backendRunning: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "open-backend-manager", "model-downloaded"]);

const showDialog = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });
const activeTab = ref("general");
const selectedModelId = ref("lama");
const activeSettingsHelpTopic = ref("");
const activeSettingsHelp = computed(
  () => settingsHelpByTopic[activeSettingsHelpTopic.value] || settingsHelp.shortcuts
);
const showSettingsHelpDialog = computed({
  get: () => Boolean(activeSettingsHelpTopic.value),
  set: (value) => {
    if (!value) activeSettingsHelpTopic.value = "";
  },
});
const saving = ref(false);
const cleaningTempFiles = ref(false);
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
const knownSamModels = computed(() => {
  const byId = new Map(fallbackSamModels.map((model) => [model.id, model]));
  modelRegistryStore.maskModels
    .filter((model) => ["sam", "sam2", "sam3"].includes(model?.family))
    .forEach((model) => byId.set(model.id, model));
  return Array.from(byId.values());
});
const formatSamDefaultModelLabel = (model = {}) => {
  const family = model.familyLabel || (model.family === "sam2" ? "SAM2.1" : model.family === "sam3" ? "SAM3" : "SAM1");
  const variant = model.variant || model.label || model.id;
  const installState = model.installed === false ? " · 未安装" : "";
  return `${family} · ${variant}${installState}`;
};
const buildSamDefaultModelOption = (model = {}) => ({
  label: formatSamDefaultModelLabel(model),
  value: model.id,
  family: model.family || "",
});
const imageSamDefaultModelOptions = computed(() =>
  knownSamModels.value
    .filter((model) => ["sam", "sam2", "sam3"].includes(model.family))
    .map(buildSamDefaultModelOption)
);
const selectedImageSamModel = computed(() =>
  knownSamModels.value.find(
    (model) => model.id === localConfig.value.masking?.imageSmartSelectionDefaultModel
  ) || null
);
const resolveImageSamCapabilities = (model = {}) => {
  const enabled = model.enabledCapabilities || {};
  const hasCapabilityMetadata = ["imagePoint", "imageBox", "imageText"].some(
    (key) => Object.hasOwn(enabled, key)
  );
  if (hasCapabilityMetadata) {
    return {
      point: enabled.imagePoint === true,
      box: enabled.imageBox === true,
      text: enabled.imageText === true,
    };
  }

  const modelId = String(model.id || "").toLowerCase();
  const family = String(model.family || "").toLowerCase();
  if (modelId === "sam3_1_multiplex") {
    return { point: false, box: false, text: true };
  }
  if (family === "sam3" || modelId === "sam3") {
    return { point: true, box: true, text: true };
  }
  return {
    point: ["sam", "sam2"].includes(family),
    box: ["sam", "sam2"].includes(family),
    text: false,
  };
};
const imageSmartSelectionModelDescription = computed(() => {
  const model = selectedImageSamModel.value;
  if (!model) {
    return "点选和框选模型：SAM1、SAM2.1、标准 SAM3；仅文本选取模型：SAM3.1 Multiplex。";
  }

  const label = formatSamDefaultModelLabel(model).replace(" · 未安装", "");
  const capabilities = resolveImageSamCapabilities(model);
  if ((capabilities.point || capabilities.box) && capabilities.text) {
    return `当前选择 ${label}：支持点选、框选和文本选取。仅文本选取模型：SAM3.1 Multiplex。`;
  }
  if (capabilities.point || capabilities.box) {
    return `当前选择 ${label}：支持点选和框选。仅文本选取模型：SAM3.1 Multiplex；标准 SAM3 还支持文本选取。`;
  }
  if (capabilities.text) {
    return `当前选择 ${label}：仅支持文本选取。如需点选或框选，请使用 SAM1、SAM2.1 或标准 SAM3。`;
  }
  return `当前选择 ${label}：当前未开放图片点选、框选或文本选取能力。`;
});
const videoSamDefaultModelOptions = computed(() =>
  knownSamModels.value
    .filter((model) => model.family === "sam2" && String(model.modelVersion || "SAM2.1").includes("SAM2.1"))
    .map(buildSamDefaultModelOption)
);
const defaultBackendModelOptions = computed(() => [
  { label: "LaMa", value: "lama" },
  {
    label: "MAT",
    value: "mat",
    disable: localConfig.value.general?.launchMode !== "cuda",
  },
]);
const mergedConfig = computed(() => ConfigManager.mergeWithDefault(localConfig.value));
const shortcutErrors = computed(() => validateShortcutConfig(localConfig.value.shortcuts));
const validationErrors = computed(() => {
  const errors = [
    ...configStore.validateConfig(ConfigManager.mergeForStrictValidation(localConfig.value)),
    ...configStore.validateConfig(mergedConfig.value),
  ];
  return [...(portError.value && portErrorMessage.value ? [portErrorMessage.value] : []), ...errors];
});
const hasErrors = computed(() => validationErrors.value.length > 0);
const isTempCleanupDisabled = computed(
  () => saving.value || cleaningTempFiles.value || Boolean(globalLoadingState.value?.showing)
);
const formatUpdateBytes = (value) => {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const unitIndex = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length - 1
  );
  const scaled = bytes / (1024 ** unitIndex);
  const precision = unitIndex === 0 || scaled >= 100 ? 0 : 1;
  return `${scaled.toFixed(precision)} ${units[unitIndex]}`;
};
const formatUpdateDateTime = (value) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value || "未知");
  return date.toLocaleString("zh-CN", { hour12: false });
};
const updateTransferSummary = computed(() => {
  const updateState = updateManager.state;
  const transferred = formatUpdateBytes(updateState.transferred);
  const total = Number(updateState.total) > 0
    ? ` / ${formatUpdateBytes(updateState.total)}`
    : "";
  const speed = Number(updateState.bytesPerSecond) > 0
    ? ` · ${formatUpdateBytes(updateState.bytesPerSecond)}/s`
    : "";
  return `${transferred}${total}${speed}`;
});
const updateStatusColor = computed(() => {
  const colors = {
    available: "info",
    downloading: "primary",
    downloaded: "positive",
    installing: "positive",
    "up-to-date": "positive",
    error: "negative",
    disabled: "grey-7",
  };
  return colors[updateManager.state.status] || "grey-7";
});
const updateStatusIcon = computed(() => ({
  available: "new_releases",
  checking: "sync",
  downloading: "downloading",
  downloaded: "task_alt",
  installing: "system_update_alt",
  "up-to-date": "verified",
  error: "error_outline",
  disabled: "update_disabled",
}[updateManager.state.status] || "update"));
const updateStatusSummary = computed(() => {
  const updateState = updateManager.state;
  if (!updateState.enabled || updateState.status === "disabled") {
    return "当前构建未启用应用更新。";
  }
  if (updateState.status === "checking") return `正在获取${updateChannelLabel.value}通道信息...`;
  if (updateState.status === "up-to-date") return "当前为最新版本。";
  if (updateState.status === "downloading") {
    const version = updateState.availableVersion || updateState.latestVersion;
    return version ? `正在下载版本 ${version}。` : "正在下载更新。";
  }
  if (["downloaded", "installing"].includes(updateState.status)) {
    const version = updateState.availableVersion || updateState.latestVersion;
    return version ? `版本 ${version} 已准备好安装。` : "更新已准备好安装。";
  }
  if (updateState.status === "error") return "上次更新操作未完成，可重试当前步骤。";
  if (updateState.availableVersion) return `可用版本 ${updateState.availableVersion}`;
  return "尚未获取版本信息。";
});
const showCheckUpdateAction = computed(
  () =>
    ["disabled", "idle", "checking", "up-to-date"].includes(updateManager.state.status) ||
    (updateManager.state.status === "error" && updateManager.retryAction === "check")
);
const showDownloadUpdateAction = computed(
  () =>
    updateManager.state.status === "available" ||
    (updateManager.state.status === "error" && updateManager.retryAction === "download")
);
const showInstallUpdateAction = computed(
  () =>
    ["downloaded", "installing"].includes(updateManager.state.status) ||
    (updateManager.state.status === "error" && updateManager.retryAction === "install")
);
const currentVersionUpdatedAtText = computed(() => {
  const value = updateManager.state.currentVersionUpdatedAt || updateManager.state.currentVersionReleaseDate || updateManager.state.installedAt;
  return value ? formatUpdateDateTime(value) : "未提供";
});
const lastUpdateCheckedAtText = computed(() =>
  updateManager.state.checkedAt ? formatUpdateDateTime(updateManager.state.checkedAt) : "尚未检查"
);
const availableReleaseDateText = computed(() =>
  updateManager.state.releaseDate ? formatUpdateDateTime(updateManager.state.releaseDate) : "未提供"
);
const runtimeEnvironmentChecking = ref(false);
const runtimeEnvironmentSwitching = ref(false);
const runtimeEnvironmentUpdate = computed(() => {
  const state = updateManager.runtimeState || {};
  const nested = state.environmentUpdate || state.runtimeUpdate;
  if (nested && typeof nested === "object") return nested;

  // Keep the panel useful while older runtimes are still returning the
  // diagnostics fields at the runtime-state root. Newer IPC responses use
  // `environmentUpdate`, but these aliases make the UI forward/backward
  // compatible during a rolling update.
  return {
    usable: state.environmentUpdateUsable ?? state.usable,
    pythonVersion: state.environmentUpdatePythonVersion ?? state.pythonVersion,
    torchVersion: state.environmentUpdateTorchVersion ?? state.torchVersion,
    torchPackage: state.environmentUpdateTorchPackage ?? state.torchPackage,
    gpuName: state.environmentUpdateGpuName ?? state.gpuName,
    nvidiaDriverVersion: state.environmentUpdateNvidiaDriverVersion ?? state.nvidiaDriverVersion,
    checkedAt: state.environmentUpdateCheckedAt ?? state.checkedAt,
    selectedAccelerator: state.environmentUpdateSelectedAccelerator ?? state.selectedAccelerator,
    canSwitchToCpu: state.environmentUpdateCanSwitchToCpu ?? state.canSwitchToCpu,
    canSwitchToCu130: state.environmentUpdateCanSwitchToCu130 ?? state.canSwitchToCu130,
    acceleratorChangeReason: state.environmentUpdateAcceleratorChangeReason ?? state.acceleratorChangeReason,
  };
});
const runtimeEnvironmentIsReady = computed(() =>
  ["ready", "degraded"].includes(updateManager.runtimeState.status)
);
const runtimeEnvironmentUpdateUsable = computed(() =>
  runtimeEnvironmentUpdate.value.usable === true && runtimeEnvironmentIsReady.value
);
const runtimeEnvironmentUpdateStatusLabel = computed(() => {
  if (runtimeEnvironmentChecking.value) return "检测中";
  if (runtimeEnvironmentSwitching.value) return "正在切换";
  if (!runtimeEnvironmentUpdateUsable.value) return "不可用";
  const accelerator = runtimeEnvironmentUpdate.value.selectedAccelerator || updateManager.runtimeState.selectedAccelerator;
  return accelerator === "cu130" ? "CUDA 运行环境" : "CPU 运行环境";
});
const runtimeEnvironmentUpdateBadgeColor = computed(() => {
  if (runtimeEnvironmentChecking.value || runtimeEnvironmentSwitching.value) return "primary";
  if (!runtimeEnvironmentUpdateUsable.value) return "grey-7";
  return runtimeEnvironmentUpdate.value.selectedAccelerator === "cu130" || updateManager.runtimeState.selectedAccelerator === "cu130"
    ? "positive"
    : "secondary";
});
const runtimeEnvironmentTorchText = computed(() => {
  const environment = runtimeEnvironmentUpdate.value;
  const version = environment.torchVersion || updateManager.runtimeState.torchVersion || "未提供";
  const packageName = environment.torchPackage === "cuda" || environment.selectedAccelerator === "cu130"
    ? "CUDA"
    : environment.torchPackage === "cpu" || environment.selectedAccelerator === "cpu"
      ? "CPU"
      : "";
  return packageName ? `${version} (${packageName})` : version;
});
const runtimeEnvironmentUpdateCheckedAtText = computed(() => {
  const checkedAt = runtimeEnvironmentUpdate.value.checkedAt || updateManager.runtimeState.checkedAt;
  return checkedAt ? `上次环境检测：${formatUpdateDateTime(checkedAt)}` : "尚未完成运行环境更新检测";
});
const runtimeEnvironmentUpdateUnavailableMessage = computed(() => {
  if (runtimeEnvironmentIsReady.value) {
    return "正在等待运行环境检测结果；可点击重新检测。";
  }
  return "请先在服务管理中创建或选择可用运行环境。";
});
const runtimeEnvironmentLastRequestedKey = ref("");
const runtimeEnvironmentPath = computed(() =>
  String(
    updateManager.runtimeState.activePath ||
    updateManager.runtimeState.targetPath ||
    updateManager.runtimeState.externalPath ||
    ""
  ).trim()
);

const refreshRuntimeEnvironmentUpdate = async () => {
  if (!runtimeEnvironmentUpdateUsable.value && !runtimeEnvironmentIsReady.value) return;
  const action = updateManager.checkEnvironmentUpdate;
  if (typeof action !== "function") return;
  runtimeEnvironmentChecking.value = true;
  try {
    const result = await action();
    notifyUpdateFailure(result, "运行环境更新检测失败。");
  } finally {
    runtimeEnvironmentChecking.value = false;
  }
};

const requestRuntimeEnvironmentSwitch = async (target) => {
  const targetLabel = target === "cu130" ? "CUDA" : "CPU";
  const planAction = updateManager.getEnvironmentSwitchPlan;
  const switchAction = updateManager.switchEnvironmentAccelerator;
  if (typeof switchAction !== "function") return;
  let plan = null;
  if (typeof planAction === "function") {
    runtimeEnvironmentChecking.value = true;
    try {
      const result = await planAction(target);
      plan = result?.plan || result?.data || result;
      if (result?.success === false) {
        notifyUpdateFailure(result, `无法切换为 ${targetLabel} 运行环境。`);
        return;
      }
    } finally {
      runtimeEnvironmentChecking.value = false;
    }
  }
  const guidance = plan?.reason || plan?.message || runtimeEnvironmentUpdate.value.acceleratorChangeReason || "切换将重新准备对应的运行环境，现有环境将保留。";
  $q.dialog({
    title: `切换为 ${targetLabel} 运行环境`,
    message: guidance,
    cancel: true,
    persistent: true,
  }).onOk(async () => {
    runtimeEnvironmentSwitching.value = true;
    try {
      const result = await switchAction({ target, confirmed: true });
      if (notifyUpdateFailure(result, `切换为 ${targetLabel} 运行环境失败。`)) return;
      $q.notify({ type: "positive", message: `已开始准备 ${targetLabel} 运行环境。`, position: "top" });
    } finally {
      runtimeEnvironmentSwitching.value = false;
    }
  });
};

const notifyUpdateFailure = (result, fallbackMessage) => {
  if (result?.success !== false) return false;
  const message =
    result?.reason ||
    result?.error?.message ||
    result?.error ||
    result?.state?.error?.message ||
    fallbackMessage;
  $q.notify({
    type: ["APP_UPDATE_INSTALL_BLOCKED", "APP_RESTART_BLOCKED"].includes(result?.code) ? "warning" : "negative",
    message,
    position: "top",
    timeout: 4500,
  });
  return true;
};

const handleCheckForUpdates = async () => {
  const result = await updateManager.checkForUpdates();
  if (notifyUpdateFailure(result, "检查更新失败。")) return;
  if (result?.state?.status === "up-to-date") {
    $q.notify({ type: "positive", message: "当前为最新版本。", position: "top" });
  }
};

const handleDownloadUpdate = async () => {
  const result = await updateManager.downloadUpdate();
  notifyUpdateFailure(result, "下载应用更新失败。");
};

const performInstallUpdate = async () => {
  const result = await updateManager.installUpdate();
  notifyUpdateFailure(result, "安装应用更新失败。");
};

const handleInstallUpdate = () => {
  if (!updateManager.canInstall) return;
  const version = updateManager.state.availableVersion || updateManager.state.latestVersion;
  $q.dialog({
    title: "重启并安装更新",
    message: version
      ? `Moonshine-Image 将关闭并安装版本 ${version}。请先保存尚未导出的内容。`
      : "Moonshine-Image 将关闭并安装已下载的更新。请先保存尚未导出的内容。",
    cancel: {
      flat: true,
      label: "暂不安装",
    },
    ok: {
      color: "primary",
      label: "重启并安装",
    },
    persistent: true,
  }).onOk(() => {
    void performInstallUpdate();
  });
};

const openSettingsHelp = (topic) => {
  const help = settingsHelpByTopic[topic];
  if (help?.helpMode === "dialog") {
    activeSettingsHelpTopic.value = topic;
  }
};

const validatePort = (port) => {
  if (!port || port < 1024 || port > 65535) {
    portError.value = true;
    portErrorMessage.value = "服务端口必须在 1024-65535 范围内。";
  } else {
    portError.value = false;
    portErrorMessage.value = "";
  }
};
const getImageProcessingHint = () => imageProcessingOptions.find((item) => item.value === (localConfig.value.advanced?.imageProcessingMethod || "auto"))?.description || "";
const getSlbrLocalInferenceHint = () => slbrLocalInferenceStrategyOptions.find((item) => item.value === (localConfig.value.advanced?.slbrLocalInferenceStrategy || "auto"))?.description || "";
const getImageOutputFormatHint = () => imageOutputFormatOptions.find((item) => item.value === (localConfig.value.advanced?.imageOutputFormat || "auto"))?.description || "";
const getVideoProcessingEngineHint = () => videoProcessingEngineOptions.find((item) => item.value === (localConfig.value.advanced?.videoProcessingEngine || "auto"))?.description || "";
const getVideoIntermediateFrameStrategyHint = () =>
  videoIntermediateFrameStrategyOptions.find((item) => item.value === (localConfig.value.video?.intermediateFrameStrategy || "performance"))?.description || "";
const getVideoEncodingQualityPresetHint = () =>
  videoEncodingQualityPresetOptions.find((item) => item.value === (localConfig.value.video?.encodingQualityPreset || "performance"))?.description || "";
const getVideoInpaintColorStabilizationHint = () =>
  videoInpaintColorStabilizationOptions.find((item) => item.value === (localConfig.value.video?.inpaintColorStabilization || "auto"))?.description || "";
const getBrushConfig = (key) => localConfig.value.advanced?.[key] || DEFAULT_IMAGE_BRUSH;
const formatBrushAlpha = (value) => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;
const getBrushPreviewStyle = (key) => {
  const brush = getBrushConfig(key);
  const size = Math.max(10, Math.min(76, Number(brush.size) || 0));
  return {
    width: `${size}px`,
    height: `${size}px`,
    backgroundColor: brush.color,
    opacity: Math.max(0.05, Math.min(1, Number(brush.alpha) || DEFAULT_IMAGE_BRUSH.alpha)),
  };
};
const getShortcutDisplayValue = (actionId) => formatShortcutKeys(recordingShortcutId.value === actionId && recordingKeys.value.length ? recordingKeys.value : localConfig.value.shortcuts?.[actionId] || []);
const stopShortcutRecording = () => { recordingShortcutId.value = ""; recordingKeys.value = []; };
const resetThemeColors = () => { localConfig.value.ui.brandColors = { ...DEFAULT_BRAND_COLORS }; };
const resetButtonSize = () => { localConfig.value.ui.buttonSize = DEFAULT_UI_BUTTON_SIZE; };
const resetBrushDefaults = () => { localConfig.value.advanced.imageBrushDefault = { ...DEFAULT_IMAGE_BRUSH }; localConfig.value.advanced.videoBrushDefault = { ...DEFAULT_VIDEO_BRUSH }; };
const resetVideoTemporalEnhancement = () => { localConfig.value.video.temporalEnhancement = { ...DEFAULT_VIDEO_TEMPORAL_ENHANCEMENT }; };
const ensureTempCleanupConfig = () => {
  if (!localConfig.value.fileManagement) {
    localConfig.value.fileManagement = {};
  }
  localConfig.value.fileManagement.tempCleanup = {
    ...DEFAULT_TEMP_CLEANUP,
    ...(localConfig.value.fileManagement.tempCleanup || {}),
  };
};
const fallbackMatDefaultModelIfNeeded = ({ notify = false } = {}) => {
  if (
    localConfig.value.general?.defaultModel !== "mat" ||
    localConfig.value.general?.launchMode === "cuda"
  ) {
    return false;
  }

  localConfig.value.general.defaultModel = "lama";
  if (notify) {
    $q.notify({ type: "warning", message: MAT_CUDA_FALLBACK_MESSAGE, position: "top" });
  }
  return true;
};
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
const copyRuntimeEnvironmentPath = async () => {
  if (!runtimeEnvironmentPath.value) return;
  try {
    await copyToClipboard(runtimeEnvironmentPath.value);
    $q.notify({ type: "positive", message: "运行环境路径已复制。", position: "top" });
  } catch (error) {
    $q.notify({ type: "negative", message: `复制运行环境路径失败：${error.message}` });
  }
};
const copyManagedPath = async (value, label = "路径") => {
  const pathValue = String(value || "").trim();
  if (!pathValue) return;
  try {
    await copyToClipboard(pathValue);
    $q.notify({ type: "positive", message: `${label}已复制。`, position: "top" });
  } catch (error) {
    $q.notify({ type: "negative", message: `复制${label}失败：${error.message}`, position: "top" });
  }
};
const openRuntimeEnvironmentPath = async () => {
  if (!runtimeEnvironmentPath.value) return;
  try {
    const ipc = window.electron?.ipcRenderer;
    const result = ipc?.openEnvironmentPath
      ? await ipc.openEnvironmentPath()
      : await ipc?.invoke?.("environment-open-path");
    if (!result?.success) {
      throw new Error(result?.error?.message || result?.error || "无法打开运行环境路径。");
    }
  } catch (error) {
    $q.notify({ type: "negative", message: `打开运行环境路径失败：${error.message}` });
  }
};
const selectDownloadPath = async () => { try { const value = await selectFolder("选择下载 / 导出路径"); if (value) localConfig.value.fileManagement.downloadPath = value; } catch (error) { $q.notify({ type: "negative", message: `选择路径失败：${error.message}` }); } };
const selectTempPath = async () => { try { const value = await selectFolder("选择临时文件路径"); if (value) localConfig.value.fileManagement.tempPath = value; } catch (error) { $q.notify({ type: "negative", message: `选择路径失败：${error.message}` }); } };
const selectModelPath = async () => {
  try {
    const value = await selectFolder("选择模型路径");
    if (!value) return;
    const validation = await validateBackendPaths({
      backendProjectPath: localConfig.value.general.backendProjectPath || "",
      modelDir: value,
    });
    if (!validation.valid) {
      $q.notify({
        type: "negative",
        message: buildBackendPathSelectionBlockedMessage(validation, {
          currentBackendProjectPath: localConfig.value.general.backendProjectPath || "",
          currentModelDir: localConfig.value.general.modelDir || "",
          selectedModelDir: value,
        }),
        position: "top",
        timeout: 6000,
      });
      return;
    }
    if (validation.warning) {
      $q.notify({
        type: "warning",
        message: buildBackendPathWarningMessage(validation),
        position: "top",
        timeout: 8000,
      });
    }
    localConfig.value.general.modelDir = value;
  } catch (error) {
    $q.notify({ type: "negative", message: `选择模型路径失败：${error.message}` });
  }
};
const selectBackendProjectPath = async () => {
  if (!window.electron?.ipcRenderer?.invoke) return;
  try {
    const value = await selectFolder("选择服务项目路径");
    if (!value) return;
    const validation = await validateBackendPaths({
      backendProjectPath: value,
      modelDir: localConfig.value.general.modelDir || "",
    });
    if (!validation.valid) {
      $q.notify({
        type: "negative",
        message: buildBackendPathSelectionBlockedMessage(validation, {
          currentBackendProjectPath: localConfig.value.general.backendProjectPath || "",
          currentModelDir: localConfig.value.general.modelDir || "",
          selectedBackendProjectPath: value,
        }),
        position: "top",
        timeout: 6000,
      });
      return;
    }
    if (validation.warning) {
      $q.notify({
        type: "warning",
        message: buildBackendPathWarningMessage(validation),
        position: "top",
        timeout: 8000,
      });
    }
    const checkResult = await window.electron.ipcRenderer.invoke("check-project", value);
    if (checkResult.success) {
      localConfig.value.general.backendProjectPath = value;
      $q.notify({ type: "positive", message: "服务项目路径设置成功", position: "top" });
      return;
    }
    $q.notify({ type: "negative", message: `无效的服务项目路径：${checkResult.error}`, position: "top" });
  } catch (error) {
    $q.notify({ type: "negative", message: `选择服务项目路径失败：${error.message}`, position: "top" });
  }
};
const cleanupAppTempFilesNow = async () => {
  if (!window.electron?.ipcRenderer?.invoke || isTempCleanupDisabled.value) return;

  cleaningTempFiles.value = true;
  try {
    const cleanupOptions = ConfigManager.mergeWithDefault(
      localConfig.value
    ).fileManagement.tempCleanup;
    const result = await window.electron.ipcRenderer.invoke(
      "cleanup-app-temp-files",
      JSON.parse(JSON.stringify(cleanupOptions))
    );
    if (!result?.success) {
      throw new Error(result?.error || "清理临时文件失败");
    }

    const removedFileCount = Number(result?.data?.removedFileCount || 0);
    const removedTaskCount = Number(result?.data?.removedTaskCount || 0);
    const removedDirectoryCount = Number(result?.data?.removedDirectoryCount || 0);
    const removedTempSourceCount = Number(result?.data?.removedTempSourceCount || 0);
    const removedTotal = removedFileCount + removedTaskCount + removedDirectoryCount + removedTempSourceCount;
    $q.notify({
      type: "positive",
      message:
        removedTotal > 0
          ? `已清理 ${removedFileCount} 个文件、${removedDirectoryCount} 个文件夹、${removedTaskCount} 个视频任务。`
          : "没有符合条件的临时文件。",
      position: "top",
      timeout: 3000,
    });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `清理临时文件失败：${error.message}`,
      position: "top",
      timeout: 3500,
    });
  } finally {
    cleaningTempFiles.value = false;
  }
};
const doSaveSettings = async () => {
  saving.value = true;
  try {
    stopShortcutRecording();
    fallbackMatDefaultModelIfNeeded({ notify: true });
    const serializableConfig = buildSerializableConfig(localConfig.value);
    const backendPathValidation = await validateBackendPaths({
      backendProjectPath: serializableConfig.general?.backendProjectPath || "",
      modelDir: serializableConfig.general?.modelDir || "",
    });
    if (!backendPathValidation.valid) {
      $q.notify({
        type: "negative",
        message: buildBackendPathBlockedMessage(backendPathValidation),
        position: "top",
        timeout: 7000,
      });
      return;
    }
    if (backendPathValidation.warning) {
      $q.notify({
        type: "warning",
        message: buildBackendPathWarningMessage(backendPathValidation),
        position: "top",
        timeout: 8000,
      });
    }

    const previousPort = configStore.config.general.backendPort;
    const storeResult = await configStore.persistConfig(serializableConfig);
    if (!storeResult.success) throw new Error(storeResult.error || storeResult.errors?.join("；") || "保存配置失败");
    if (serializableConfig.advanced?.imageProcessingMethod) {
      const processingMethod = serializableConfig.advanced.imageProcessingMethod;
      fileManagerStore.processingConfig.method = processingMethod;
      fileManagerStore.processingConfig.imageType =
        processingMethod === "base64" ? "base64" : "path";
      fileManagerStore.processingConfig.responseType =
        processingMethod === "base64" ? "base64" : "path";
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
const applyInitialTarget = () => {
  if (props.initialTab) {
    const requestedTab = props.initialTab === "advanced" ? "image" : props.initialTab;
    const validTabs = ["general", "backend", "models", "files", "appearance", "image", "video", "updates", "mcp"];
    activeTab.value = validTabs.includes(requestedTab) ? requestedTab : "general";
  }
  if (props.initialModelId) selectedModelId.value = props.initialModelId;
};
const handleModelDownloaded = (modelId) => {
  emit("model-downloaded", modelId);
};
const handleDefaultSamModelUpdated = (payload) => {
  if (!localConfig.value.masking) {
    localConfig.value.masking = {};
  }
  const modelId = typeof payload === "string" ? payload : payload?.modelId;
  const configKey = typeof payload === "object" ? payload?.configKey : "defaultSamModel";
  if (!modelId || !configKey) return;
  localConfig.value.masking[configKey] = modelId;
  if (configKey === "defaultSam1Model") {
    localConfig.value.masking.defaultSamModel = modelId;
  }
};

watch(() => props.modelValue, (opened) => {
  if (!opened) {
    stopShortcutRecording();
    return;
  }
  localConfig.value = buildSerializableConfig(configStore.config);
  ensureTempCleanupConfig();
  validatePort(localConfig.value.general.backendPort);
  applyInitialTarget();
}, { immediate: true });
watch(() => [props.initialTab, props.initialModelId, props.initialMcpTab, props.navigationKey], () => {
  if (showDialog.value) {
    applyInitialTarget();
  }
});
watch(
  () => [showDialog.value, activeTab.value, updateManager.runtimeState.status, updateManager.runtimeState.activePath],
  () => {
    if (!showDialog.value || activeTab.value !== "updates") return;
    if (!["ready", "degraded"].includes(updateManager.runtimeState.status)) return;
    if (typeof updateManager.checkEnvironmentUpdate !== "function") return;
    const requestKey = `${updateManager.runtimeState.activePath || ""}:${updateManager.runtimeState.updatedAt || ""}`;
    if (runtimeEnvironmentLastRequestedKey.value === requestKey) return;
    runtimeEnvironmentLastRequestedKey.value = requestKey;
    void refreshRuntimeEnvironmentUpdate();
  },
  { immediate: true }
);
watch(() => configStore.config, (newConfig) => {
  if (!showDialog.value) {
    localConfig.value = buildSerializableConfig(newConfig);
    ensureTempCleanupConfig();
  }
}, { deep: true });
watch(() => localConfig.value.general.backendPort, (port) => { validatePort(port); }, { immediate: true });
watch(
  () => [localConfig.value.general?.launchMode, localConfig.value.general?.defaultModel],
  () => {
    fallbackMatDefaultModelIfNeeded({ notify: true });
  }
);

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
:deep(.settings-dialog .q-dialog),
:deep(.settings-dialog .q-dialog__backdrop) {
  z-index: 3000 !important;
}
.settings-card {
  --settings-card-surface: #ffffff;
  --settings-block-surface: rgba(255, 255, 255, 0.72);
  --settings-mini-surface: rgba(255, 255, 255, 0.72);
  --settings-toggle-surface: rgba(255, 255, 255, 0.72);
  --settings-border: rgba(17, 24, 39, 0.08);
  --settings-text-primary: rgba(17, 24, 39, 0.92);
  --settings-text-secondary: rgba(17, 24, 39, 0.62);
  --settings-field-surface: transparent;
  width: min(1180px, calc(100vw - clamp(16px, 4vw, 48px)));
  max-width: calc(100vw - clamp(16px, 4vw, 48px));
  height: min(900px, calc(100vh - clamp(16px, 4vh, 48px)));
  max-height: calc(100vh - clamp(16px, 4vh, 48px));
  display: flex;
  flex-direction: column;
  background: var(--settings-card-surface);
  overflow: hidden;
}
.settings-header,
.settings-actions {
  flex: 0 0 auto;
}
.settings-workspace { display: flex; flex: 1 1 auto; min-height: 0; }
.settings-sidebar {
  flex: 0 0 184px;
  min-width: 0;
  padding: 12px 8px;
  background: rgba(119, 88, 196, 0.035);
}
.settings-main-tabs { width: 100%; }
.settings-main-tabs :deep(.q-tab) {
  min-height: 44px;
  justify-content: flex-start;
  border-radius: 10px;
  margin: 2px 0;
  padding: 0 12px;
}
.settings-main-tabs :deep(.q-tab__content) { flex-direction: row; justify-content: flex-start; gap: 10px; }
.settings-main-tabs :deep(.q-tab__label) { white-space: nowrap; }
.settings-content-section {
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  padding: 8px 16px 0;
}
.settings-scroll-area { height: 100%; }
.section { padding-top: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.settings-panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
.settings-panel-grid--service { grid-template-columns: repeat(3, minmax(0, 1fr)); }
.settings-panel-grid--file-management { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.settings-panel-grid--image-core { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.block, .mini-block { border: 1px solid var(--settings-border); border-radius: 16px; }
.block { background: var(--settings-block-surface); }
.mini-block { background: var(--settings-mini-surface); }
.block { padding: 16px; }
.mini-block { padding: 14px; }
.shortcut-row { display: grid; grid-template-columns: minmax(0, 1fr) 220px auto; gap: 12px; align-items: center; padding: 14px; border-radius: 14px; background: rgba(119, 88, 196, 0.05); border: 1px solid rgba(119, 88, 196, 0.08); }
.shortcut-row.recording { border-color: rgba(25, 118, 210, 0.28); background: rgba(25, 118, 210, 0.06); }
.shortcut-meta { min-width: 0; }
.shortcut-input { min-width: 0; }
.shortcut-actions { display: flex; gap: 8px; }
.settings-action-button { min-height: 40px; }
.settings-action-button :deep(.q-btn__content) {
  justify-content: center;
  flex-wrap: nowrap;
  gap: 6px;
  white-space: nowrap;
}
.settings-action-button :deep(.q-icon.on-left) { margin-right: 0; }
.update-release-notes { white-space: pre-wrap; overflow-wrap: anywhere; line-height: 1.65; }
.update-panel-block--app { overflow: hidden; }
.update-status-hero {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 12px;
}
.update-status-hero__icon {
  display: grid;
  width: 42px;
  min-width: 42px;
  height: 42px;
  place-items: center;
  border: 1px solid rgba(117, 88, 196, 0.18);
  border-radius: 12px;
  background: rgba(117, 88, 196, 0.09);
  color: var(--q-primary);
}
.update-status-hero__icon--positive { border-color: rgba(33, 186, 69, 0.22); background: rgba(33, 186, 69, 0.1); color: #168343; }
.update-status-hero__icon--negative { border-color: rgba(193, 42, 58, 0.24); background: rgba(193, 42, 58, 0.1); color: #c12a3a; }
.update-status-hero__icon--info { border-color: rgba(33, 150, 243, 0.22); background: rgba(33, 150, 243, 0.1); color: #1976d2; }
.update-status-hero__copy { min-width: 0; flex: 1 1 auto; }
.update-status-hero__eyebrow { color: var(--settings-text-secondary); font-size: 11px; line-height: 1.3; }
.update-status-hero__title { overflow-wrap: anywhere; color: var(--settings-text-primary); font-size: 15px; font-weight: 600; line-height: 1.45; }
.update-meta-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.update-meta-item {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 8px;
  padding: 9px 10px;
  border: 1px solid var(--settings-border);
  border-radius: 10px;
  background: var(--settings-field-surface);
  color: var(--settings-text-secondary);
}
.update-meta-item > div { min-width: 0; }
.update-meta-item__label { font-size: 11px; line-height: 1.3; }
.update-meta-item__value { overflow-wrap: anywhere; color: var(--settings-text-primary); font-size: 12px; line-height: 1.45; }
.environment-update-card { overflow: hidden; }
.environment-update-card__header { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.environment-update-card__icon {
  display: grid;
  width: 38px;
  height: 38px;
  place-items: center;
  border-radius: 11px;
  background: rgba(117, 88, 196, 0.1);
  color: var(--q-primary);
}
.environment-update-card__status { flex: 0 0 auto; }
.environment-update-metrics { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px; }
.environment-update-metric {
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--settings-border);
  border-radius: 10px;
  background: var(--settings-field-surface);
}
.environment-update-metric span { display: block; color: var(--settings-text-secondary); font-size: 11px; line-height: 1.3; }
.environment-update-metric strong { display: block; overflow-wrap: anywhere; margin-top: 3px; color: var(--settings-text-primary); font-size: 12px; line-height: 1.45; }
.environment-update-card__footer { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.environment-update-card__footer > .row { justify-content: flex-end; }
.environment-update-empty { display: flex; align-items: flex-start; gap: 10px; padding: 12px; border: 1px dashed var(--settings-border); border-radius: 10px; color: var(--settings-text-secondary); }
.environment-update-hint { display: flex; align-items: flex-start; gap: 8px; color: var(--settings-text-secondary); font-size: 12px; line-height: 1.5; }
.settings-section-heading { gap: 8px; }
.settings-help-button {
  width: 44px;
  min-width: 44px;
  height: 44px;
  min-height: 44px;
  color: var(--settings-text-secondary);
}
  .settings-icon-button {
  width: 44px;
  min-width: 44px;
  height: 44px;
    min-height: 44px;
  }
  .settings-copy-button {
    width: 32px;
    min-width: 32px;
    height: 32px;
    min-height: 32px;
  }
.cleanup-row { display: flex; align-items: center; gap: 16px; }
.cleanup-copy { flex: 1 1 auto; min-width: 0; }
.cleanup-button { flex: 0 0 auto; }
.brush-default-preview { display: flex; height: 112px; align-items: center; justify-content: center; overflow: hidden; border: 1px solid var(--settings-border); border-radius: 8px; background-color: var(--settings-toggle-surface); background-image: linear-gradient(45deg, rgba(148,163,184,.14) 25%, transparent 25%), linear-gradient(-45deg, rgba(148,163,184,.14) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, rgba(148,163,184,.14) 75%), linear-gradient(-45deg, transparent 75%, rgba(148,163,184,.14) 75%); background-size: 18px 18px; background-position: 0 0, 0 9px, 9px -9px, -9px 0; }
.brush-default-preview__dot { display: block; flex: 0 0 auto; border-radius: 999px; border: 1px solid rgba(255,255,255,.82); box-shadow: 0 0 0 1px rgba(17,24,39,.12); }
.brush-default-controls { display: flex; flex-direction: column; gap: 14px; }
.color-row { display: flex; min-height: 38px; align-items: center; gap: 10px; }
.native-color-input { width: 42px; height: 32px; flex: 0 0 auto; border: 1px solid var(--settings-border); border-radius: 8px; padding: 0; overflow: hidden; background: transparent; cursor: pointer; }
.brush-control-label, .brush-control-header { color: var(--settings-text-secondary); font-size: 12px; line-height: 1.4; }
.brush-control-header { display: flex; min-height: 22px; align-items: center; justify-content: space-between; gap: 12px; }
.brush-control-field :deep(.q-slider) { margin-top: 2px; }
.brush-control-value { color: var(--settings-text-secondary); font-size: 12px; font-variant-numeric: tabular-nums; white-space: nowrap; }
.brush-control-value--color { margin-left: auto; }
.settings-inline-description { margin: 10px 0 0; color: var(--settings-text-secondary); font-size: 12px; line-height: 1.55; }
.startup-preferences-row { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 16px; }
.settings-toggle-control { display: flex; min-height: 44px; align-items: center; justify-content: space-between; gap: 16px; color: var(--settings-text-secondary); }
.settings-toggle-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; align-items: center; }
.startup-preference { display: flex; align-items: center; justify-content: space-between; min-height: 56px; padding: 12px 16px; border: 1px solid var(--settings-border); border-radius: 16px; background: var(--settings-toggle-surface); }
.startup-preference--compact { min-height: 44px; padding: 8px 12px; }
.startup-preference-label { font-size: 15px; font-weight: 500; }
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
.settings-help-dialog { z-index: 3100 !important; }
:deep(.settings-help-dialog .q-dialog),
:deep(.settings-help-dialog .q-dialog__backdrop) { z-index: 3100 !important; }
.settings-help-card { width: min(560px, calc(100vw - 32px)); }
.settings-help-summary { margin: 0; line-height: 1.7; }
.settings-help-details { margin: 14px 0 0; padding-left: 20px; }
.settings-help-details li { margin-top: 8px; line-height: 1.65; }
.confirm-dialog { z-index: 3100 !important; }
:deep(.confirm-dialog .q-dialog), :deep(.confirm-dialog .q-dialog__backdrop) { z-index: 3100 !important; }
:global(body.body--dark) .settings-card {
  background: #242426;
  color: rgba(255, 255, 255, 0.9);
}
.settings-card--dark {
  --settings-card-surface: #242426;
  --settings-block-surface: #2f2f32;
  --settings-mini-surface: #363638;
  --settings-toggle-surface: #303033;
  --settings-border: rgba(255, 255, 255, 0.12);
  --settings-text-primary: rgba(255, 255, 255, 0.9);
  --settings-text-secondary: rgba(255, 255, 255, 0.62);
  --settings-field-surface: rgba(255, 255, 255, 0.045);
  background: var(--settings-card-surface);
  color: var(--settings-text-primary);
}
:global(body.body--dark) .settings-card :deep(.text-grey-7),
.settings-card--dark :deep(.text-grey-7) {
  color: rgba(255, 255, 255, 0.62) !important;
}
:global(body.body--dark) .block,
:global(body.body--dark) .mini-block,
:global(body.body--dark) .startup-preference,
.settings-card--dark .block,
.settings-card--dark .mini-block,
.settings-card--dark .startup-preference {
  border-color: var(--settings-border);
}
:global(body.body--dark) .mini-block,
.settings-card--dark .mini-block {
  background: var(--settings-mini-surface);
}
:global(body.body--dark) .startup-preference,
.settings-card--dark .startup-preference {
  background: var(--settings-toggle-surface);
}
:global(body.body--dark) .shortcut-row,
.settings-card--dark .shortcut-row {
  background: #38373d;
  border-color: rgba(138, 113, 212, 0.28);
}
:global(body.body--dark) .shortcut-row.recording,
.settings-card--dark .shortcut-row.recording {
  background: rgba(138, 113, 212, 0.18);
  border-color: rgba(138, 113, 212, 0.42);
}
:global(body.body--dark) .settings-info-banner,
.settings-card--dark .settings-info-banner {
  background: rgba(122, 141, 190, 0.2);
  color: #dce4ff;
  border-color: rgba(122, 141, 190, 0.34);
}
:global(body.body--dark) .settings-warning-banner,
.settings-card--dark .settings-warning-banner {
  background: rgba(230, 172, 0, 0.18);
  color: #ffe1a0;
  border-color: rgba(230, 172, 0, 0.34);
}
:global(body.body--dark) .settings-card :deep(.q-field--outlined .q-field__control),
.settings-card--dark :deep(.q-field--outlined .q-field__control) {
  background: var(--settings-field-surface);
}
:global(body.body--dark) .settings-card :deep(.q-field--outlined .q-field__native),
:global(body.body--dark) .settings-card :deep(.q-field--outlined .q-field__label),
.settings-card--dark :deep(.q-field--outlined .q-field__native),
.settings-card--dark :deep(.q-field--outlined .q-field__label) {
  color: rgba(255, 255, 255, 0.86);
}
:global(body.body--dark) .settings-card :deep(.q-tab-panels),
:global(body.body--dark) .settings-card :deep(.q-tab-panel),
.settings-card--dark :deep(.q-tab-panels),
.settings-card--dark :deep(.q-tab-panel) {
  background: transparent;
}
:global(body.body--dark) .native-color-input,
.settings-card--dark .native-color-input {
  filter: brightness(0.92);
}
@media (max-width: 900px) {
  .settings-sidebar { flex-basis: 64px; padding-inline: 6px; }
  .settings-content-section { padding-inline: 12px; }
  .settings-main-tabs :deep(.q-tab) { justify-content: center; padding-inline: 0; }
  .settings-main-tabs :deep(.q-tab__content) { justify-content: center; }
  .settings-main-tabs :deep(.q-tab__label) { display: none; }
  .settings-panel-grid--service { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .shortcut-row { grid-template-columns: 1fr; }
  .shortcut-actions { justify-content: flex-end; flex-wrap: wrap; }
  .cleanup-row { align-items: stretch; flex-direction: column; }
  .cleanup-button { width: 100%; }
  .grid,
  .settings-panel-grid,
  .settings-toggle-grid {
    grid-template-columns: minmax(0, 1fr) !important;
  }
}
@media (max-width: 760px) {
  .settings-card {
    width: calc(100vw - 12px);
    max-width: calc(100vw - 12px);
    height: calc(100vh - 12px);
    max-height: calc(100vh - 12px);
  }
  .startup-preferences-row { grid-template-columns: 1fr; }
  .settings-panel-grid--service { grid-template-columns: 1fr; }
  .settings-panel-grid--image-core { grid-template-columns: minmax(0, 1fr); }
  .update-meta-grid, .environment-update-metrics { grid-template-columns: minmax(0, 1fr); }
  .environment-update-card__footer { align-items: flex-start; flex-direction: column; }
  .environment-update-card__footer > .row { justify-content: flex-start; }
}
</style>

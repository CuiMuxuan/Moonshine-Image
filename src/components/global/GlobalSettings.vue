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

      <q-card-section class="settings-tabs-section q-pt-sm">
        <q-tabs
          v-model="activeTab"
          dense
          align="justify"
          active-color="primary"
          indicator-color="primary"
          outside-arrows
          mobile-arrows
          class="settings-main-tabs"
        >
          <q-tab
            name="general"
            label="通用配置"
            data-testid="global-settings-tab-general"
          />
          <q-tab
            name="backend"
            label="后端配置"
            data-testid="global-settings-tab-backend"
          />
          <q-tab
            name="models"
            label="模型管理"
            data-testid="global-settings-tab-models"
          />
          <q-tab name="files" label="文件管理" data-testid="global-settings-tab-files" />
          <q-tab
            name="appearance"
            label="外观主题"
            data-testid="global-settings-tab-appearance"
          />
          <q-tab
            name="advanced"
            label="高级配置"
            data-testid="global-settings-tab-advanced"
          />
        </q-tabs>
        <q-separator class="q-mt-sm" />
      </q-card-section>

      <q-card-section class="settings-content-section">
        <q-scroll-area class="settings-scroll-area">
          <q-tab-panels v-model="activeTab" animated class="bg-transparent">
            <q-tab-panel name="general" class="q-px-none">
              <div class="section">
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
              <div class="section settings-panel-grid">
                <SettingsPanel v-bind="settingsHelp.backendPort" @request-help="openSettingsHelp">
                  <q-input
                    v-model.number="localConfig.general.backendPort"
                    label="后端端口"
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
                  <q-input v-model="localConfig.general.backendProjectPath" label="后端项目路径" outlined dense readonly>
                    <template #append>
                      <q-btn round dense flat icon="folder" class="settings-icon-button" aria-label="选择后端项目路径" @click="selectBackendProjectPath" />
                    </template>
                  </q-input>
                </SettingsPanel>
                <SettingsPanel v-bind="settingsHelp.modelDir" @request-help="openSettingsHelp">
                  <q-input v-model="localConfig.general.modelDir" label="模型目录" outlined dense readonly>
                    <template #append>
                      <q-btn round dense flat icon="folder" class="settings-icon-button" aria-label="选择模型目录" @click="selectModelPath" />
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
                <div class="settings-panel-grid">
                  <SettingsPanel v-bind="settingsHelp.downloadPath" @request-help="openSettingsHelp">
                    <q-input v-model="localConfig.fileManagement.downloadPath" label="下载 / 导出路径" outlined dense readonly>
                      <template #append>
                        <q-btn round dense flat icon="folder" class="settings-icon-button" aria-label="选择下载或导出路径" @click="selectDownloadPath" />
                      </template>
                    </q-input>
                  </SettingsPanel>
                  <SettingsPanel v-bind="settingsHelp.tempPath" @request-help="openSettingsHelp">
                    <q-input v-model="localConfig.fileManagement.tempPath" label="临时文件路径" outlined dense readonly>
                      <template #append>
                        <q-btn round dense flat icon="folder" class="settings-icon-button" aria-label="选择临时文件路径" @click="selectTempPath" />
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
                        清理配置临时目录下的图片和视频中间文件，最近失败现场可按需保留。
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
                        aria-label="自动启动后端"
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
                        <q-space />
                        <span class="brush-dot" :style="{ backgroundColor: getBrushConfig(item.key).color, opacity: getBrushConfig(item.key).alpha, width: `${Math.max(12, getBrushConfig(item.key).size)}px`, height: `${Math.max(12, getBrushConfig(item.key).size)}px` }"></span>
                      </div>
                      <div class="q-gutter-md">
                        <div class="color-row">
                          <input
                            v-model="localConfig.advanced[item.key].color"
                            type="color"
                            class="native-color-input"
                            :aria-label="`${item.label}颜色选择器`"
                          />
                          <q-input v-model="localConfig.advanced[item.key].color" dense outlined label="颜色" />
                        </div>
                        <q-slider v-model="localConfig.advanced[item.key].size" label label-always :min="1" :max="120" :step="1" :aria-label="`${item.label}画笔大小`"><template #prepend>大小</template></q-slider>
                        <q-slider v-model="localConfig.advanced[item.key].alpha" label label-always :min="0.05" :max="1" :step="0.05" :aria-label="`${item.label}画笔透明度`"><template #prepend>透明度</template></q-slider>
                      </div>
                      <div class="text-caption text-grey-7 q-mt-sm">{{ item.description }}</div>
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
                      <div class="settings-panel-grid">
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
                      </div>

                      <SettingsPanel v-bind="settingsHelp.imageProcessingMethod" @request-help="openSettingsHelp">
                        <q-select v-model="localConfig.advanced.imageProcessingMethod" :options="imageProcessingOptions" emit-value map-options outlined dense :disable="!canChangeImageProcessingMethod" />
                        <div v-if="!canChangeImageProcessingMethod" class="text-caption text-orange q-mt-xs">当前已有图片载入，暂时不能切换处理方式。</div>
                        <template #description>{{ getImageProcessingHint() }}</template>
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
                      </SettingsPanel>

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

                  </q-tab-panel>

                  <q-tab-panel name="video" class="q-pa-none">
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

                  </q-tab-panel>
                </q-tab-panels>
              </div>
            </q-tab-panel>
          </q-tab-panels>
        </q-scroll-area>
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
import { useQuasar } from "quasar";
import ModelManagementPanel from "src/components/global/ModelManagementPanel.vue";
import SettingsPanel from "src/components/global/SettingsPanel.vue";
import { ConfigManager, DEFAULT_BRAND_COLORS, DEFAULT_IMAGE_BRUSH, DEFAULT_MASKING_CONFIG, DEFAULT_TEMP_CLEANUP, DEFAULT_UI_BUTTON_SIZE, DEFAULT_VIDEO_BRUSH, DEFAULT_VIDEO_TEMPORAL_ENHANCEMENT, UI_BUTTON_SIZE_OPTIONS, VIDEO_ENCODING_QUALITY_PRESET_OPTIONS, VIDEO_INPAINT_COLOR_STABILIZATION_OPTIONS, VIDEO_INTERMEDIATE_FRAME_STRATEGY_OPTIONS, VIDEO_PROCESSING_ENGINE_OPTIONS, VIDEO_TEMPORAL_ENHANCEMENT_MODES } from "src/config/ConfigManager";
import { createDefaultShortcuts, formatShortcutKeys, getShortcutDefinition, getShortcutTokenFromKeyboardEvent, getShortcutsByGroup, normalizeShortcutKeys, SHORTCUT_GROUP_META, SHORTCUT_GROUPS, validateShortcutConfig } from "src/utils/shortcutConfig";
import { useAppStateStore } from "src/stores/appState";
import { useConfigStore } from "src/stores/config";
import { useFileManagerStore } from "src/stores/fileManager";
import { useModelRegistryStore } from "src/stores/modelRegistry";
import {
  buildBackendPathBlockedMessage,
  buildBackendPathSelectionBlockedMessage,
  validateBackendPaths,
} from "src/utils/backendPathValidation";

const $q = useQuasar();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const fileManagerStore = useFileManagerStore();
const modelRegistryStore = useModelRegistryStore();
const globalLoadingState = inject("globalLoadingState", ref({ showing: false }));

const launchModeOptions = [{ label: "CUDA 加速", value: "cuda" }, { label: "CPU 模式", value: "cpu" }];
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
  backendPort: createSettingsHelp("backend-port", "后端端口", "后端服务监听的本机端口，修改后会重新加载页面以应用。"),
  launchMode: createSettingsHelp("launch-mode", "启动方式", "CUDA 模式优先使用显卡；CPU 模式兼容性更高，但处理速度通常较慢。"),
  backendProjectPath: createSettingsHelp("backend-project-path", "后端项目路径", "外部 Python 后端所在目录，应包含项目运行所需的完整文件。"),
  modelDir: createSettingsHelp("model-directory", "模型目录", "集中存放处理模型的目录，后端启动和模型管理会共同使用。"),
  defaultModel: createSettingsHelp("default-backend-model", "默认模型", "新建图片处理任务时优先选用的补洞模型。"),
  downloadPath: createSettingsHelp("download-path", "下载 / 导出路径", "图片和视频未指定其他位置时默认保存到此目录。"),
  tempPath: createSettingsHelp("temp-path", "临时文件路径", "处理过程中的帧、缓存和中间结果保存在此目录。"),
  imageFolderName: createSettingsHelp("image-folder-name", "图片输出文件夹名", "批量导出图片时在导出根目录下创建的单级文件夹。"),
  videoFolderName: createSettingsHelp("video-folder-name", "视频输出文件夹名", "批量导出视频时在导出根目录下创建的单级文件夹。"),
  tempCleanup: createSettingsHelp(
    "temp-cleanup",
    "临时文件清理",
    "按保留时间清理应用临时目录中的图片、视频中间文件和已完成任务现场。",
    "dialog",
    [
      "自动清理关闭时不会在启动阶段执行，但仍可使用“立即清理”。",
      "最近失败现场用于故障排查；启用保留后，仅删除超过保留数量的较旧现场。",
      "清理范围仅限应用管理的临时子目录，不会处理导出目录或其他任意路径。",
    ]
  ),
  startupAnimation: createSettingsHelp("startup-animation", "启动动画", "控制应用启动阶段是否显示过渡动画。"),
  autoStart: createSettingsHelp("auto-start-backend", "自动启动后端", "应用打开后自动准备并启动后端服务；关闭后可在主界面手动启动。"),
  buttonSize: createSettingsHelp("drawing-button-size", "绘制工具按钮大小", "调整图片和视频绘制工具按钮的默认尺寸，不改变画布或导出结果。"),
  imageHistoryLimit: createSettingsHelp("image-history-limit", "图片历史记录上限", "限制图片处理页可撤销和恢复的历史步骤数量。"),
  imageWarningSize: createSettingsHelp("image-warning-size", "图片警告大小", "单张图片超过该体积时提示资源占用风险，并影响自动传输策略。"),
  stateSaveLimit: createSettingsHelp("state-save-limit", "状态保存上限", "限制页面状态持久化体积，避免过大的会话数据拖慢保存与恢复。"),
  imageProcessingMethod: createSettingsHelp(
    "image-processing-method",
    "图片处理方式",
    "自动模式会按图片数量、单图体积和总量选择路径或 Base64；路径模式更节省内存，Base64 更适合少量小图。"
  ),
  imageSmartSelectionModel: createSettingsHelp(
    "image-smart-selection-model",
    "智能选区默认模型",
    "SAM1/SAM2.1 支持点选与框选，SAM3/SAM3.1 支持文本智选。未安装的模型需先在模型管理中准备。"
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
  backendRunning: { type: Boolean, default: false },
});
const emit = defineEmits(["update:modelValue", "open-backend-manager", "model-downloaded"]);

const showDialog = computed({ get: () => props.modelValue, set: (value) => emit("update:modelValue", value) });
const activeTab = ref("general");
const advancedTab = ref("image");
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

const openSettingsHelp = (topic) => {
  const help = settingsHelpByTopic[topic];
  if (help?.helpMode === "dialog") {
    activeSettingsHelpTopic.value = topic;
  }
};

const validatePort = (port) => {
  if (!port || port < 1024 || port > 65535) {
    portError.value = true;
    portErrorMessage.value = "后端端口必须在 1024-65535 范围内。";
  } else {
    portError.value = false;
    portErrorMessage.value = "";
  }
};
const getImageProcessingHint = () => imageProcessingOptions.find((item) => item.value === (localConfig.value.advanced?.imageProcessingMethod || "auto"))?.description || "";
const getImageOutputFormatHint = () => imageOutputFormatOptions.find((item) => item.value === (localConfig.value.advanced?.imageOutputFormat || "auto"))?.description || "";
const getVideoProcessingEngineHint = () => videoProcessingEngineOptions.find((item) => item.value === (localConfig.value.advanced?.videoProcessingEngine || "auto"))?.description || "";
const getVideoIntermediateFrameStrategyHint = () =>
  videoIntermediateFrameStrategyOptions.find((item) => item.value === (localConfig.value.video?.intermediateFrameStrategy || "performance"))?.description || "";
const getVideoEncodingQualityPresetHint = () =>
  videoEncodingQualityPresetOptions.find((item) => item.value === (localConfig.value.video?.encodingQualityPreset || "performance"))?.description || "";
const getVideoInpaintColorStabilizationHint = () =>
  videoInpaintColorStabilizationOptions.find((item) => item.value === (localConfig.value.video?.inpaintColorStabilization || "auto"))?.description || "";
const getBrushConfig = (key) => localConfig.value.advanced?.[key] || DEFAULT_IMAGE_BRUSH;
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
const selectDownloadPath = async () => { try { const value = await selectFolder("选择下载 / 导出目录"); if (value) localConfig.value.fileManagement.downloadPath = value; } catch (error) { $q.notify({ type: "negative", message: `选择目录失败：${error.message}` }); } };
const selectTempPath = async () => { try { const value = await selectFolder("选择临时文件目录"); if (value) localConfig.value.fileManagement.tempPath = value; } catch (error) { $q.notify({ type: "negative", message: `选择目录失败：${error.message}` }); } };
const selectModelPath = async () => {
  try {
    const value = await selectFolder("选择模型目录");
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
    localConfig.value.general.modelDir = value;
  } catch (error) {
    $q.notify({ type: "negative", message: `选择模型目录失败：${error.message}` });
  }
};
const selectBackendProjectPath = async () => {
  if (!window.electron?.ipcRenderer?.invoke) return;
  try {
    const value = await selectFolder("选择后端项目路径");
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
          ? `已清理 ${removedFileCount} 个文件、${removedDirectoryCount} 个目录、${removedTaskCount} 个视频任务。`
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
  if (props.initialTab) activeTab.value = props.initialTab;
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
watch(() => [props.initialTab, props.initialModelId], () => {
  if (showDialog.value) {
    applyInitialTarget();
  }
});
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
  width: min(1040px, calc(100vw - clamp(16px, 4vw, 48px)));
  max-width: calc(100vw - clamp(16px, 4vw, 48px));
  height: min(900px, calc(100vh - clamp(16px, 4vh, 48px)));
  max-height: calc(100vh - clamp(16px, 4vh, 48px));
  display: flex;
  flex-direction: column;
  background: var(--settings-card-surface);
  overflow: hidden;
}
.settings-header,
.settings-tabs-section,
.settings-actions {
  flex: 0 0 auto;
}
.settings-tabs-section { padding-bottom: 0; }
.settings-main-tabs :deep(.q-tab) {
  min-width: 112px;
  min-height: 44px;
}
.settings-content-section {
  flex: 1 1 auto;
  min-height: 0;
  padding-top: 8px;
}
.settings-scroll-area { height: 100%; }
.section { padding-top: 4px; }
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; }
.settings-panel-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 16px; }
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
.cleanup-row { display: flex; align-items: center; gap: 16px; }
.cleanup-copy { flex: 1 1 auto; min-width: 0; }
.cleanup-button { flex: 0 0 auto; }
.color-row { display: flex; align-items: center; gap: 12px; }
.native-color-input { width: 52px; height: 40px; border: 0; padding: 0; background: transparent; cursor: pointer; }
.color-row :deep(.q-field) { flex: 1 1 auto; }
.settings-inline-description { margin: 10px 0 0; color: var(--settings-text-secondary); font-size: 12px; line-height: 1.55; }
.brush-dot { display: inline-block; border-radius: 999px; border: 1px solid rgba(255,255,255,.72); box-shadow: 0 0 0 1px rgba(17,24,39,.08); }
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
  .shortcut-row { grid-template-columns: 1fr; }
  .shortcut-actions { justify-content: flex-end; flex-wrap: wrap; }
  .cleanup-row { align-items: stretch; flex-direction: column; }
  .cleanup-button { width: 100%; }
}
@media (max-width: 700px) {
  .settings-card {
    width: calc(100vw - 12px);
    max-width: calc(100vw - 12px);
    height: calc(100vh - 12px);
    max-height: calc(100vh - 12px);
  }
  .startup-preferences-row { grid-template-columns: 1fr; }
}
</style>

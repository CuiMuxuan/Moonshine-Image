<template>
  <q-page class="video-page" data-testid="video-page">
    <div v-if="isProcessing || samVideoState.running" class="processing-page-mask"></div>
    <div class="video-layout">
      <div class="top-row" :class="{ 'has-timeline': videoStore.hasVideoFile }">
        <q-card class="left-panel">
          <q-card-section class="side-panel-body">
            <ResourceManage
              v-model:active-tab="resourceManageTab"
              v-model:export-fps-mode="exportFpsMode"
              :fps-options="fpsOptions"
              :preview-size-text="previewSizeText"
              :export-size-text="exportSizeText"
              :computed-batch-size="computedBatchSize"
              :can-run="canRun"
              :can-open-output="canOpenOutput"
              :is-processing="isProcessing"
              :processing-progress="processingProgress"
              :processing-message="processingMessage"
              :last-output-path="lastOutputPath"
              :processing-succeeded="processingSucceeded"
              :last-output-is-preview="lastOutputIsPreview"
              :preview-trial-seconds="previewTrialSeconds"
              :preview-trial-options="previewTrialOptions"
              :can-replace-source="canReplaceCurrentSource"
              :can-rollback-history="videoStore.canOpenVideoHistory"
              :engine-run-disabled="backendEngineValue.runDisabled"
              :engine-run-tooltip="backendEngineValue.runDisabledTooltip"
              :engine-preparing="backendEngineValue.isPreparing"
              :engine-preparing-label="backendEngineValue.runDisabledTooltip"
              :engine-failed="backendEngineValue.hasFailed"
              :history-entries="historyEntries"
              :current-model="currentModel"
              :model-options="videoModelOptions"
              :current-model-metadata="currentModelMetadata"
              :model-parameter-values="modelParameterValues"
              :backend-running="backendEngineValue.isRunning || backendRunningState"
              :sam-video-running="samVideoState.running"
              :sam-video-action-disabled="!canRunSamVideoSelectionFromMaskList"
              :sam-video-action-tooltip="samVideoSelectionActionTooltip"
              @run="runVideoProcessing"
              @run-preview="runVideoPreviewTrial"
              @update:preview-trial-seconds="previewTrialSeconds = $event"
              @update:current-model="handleModelChange"
              @update-model-parameter="updateModelParameter"
              @apply-recommended-parameters="applyRecommendedModelParameters"
              @open-model-management="openModelManagement"
              @open-diagnostics="backendEngineValue.openDiagnostics"
              @open-output="openOutputDir"
              @replace-source="replaceCurrentVideoSource"
              @restore-history="restoreVideoHistory"
              @run-sam-video-selection="runSamVideoSelectionFromMaskList"
              @remove-mask="removeVideoMaskTrack"
            />
          </q-card-section>
        </q-card>

        <q-card class="center-panel">
          <q-card-section class="player-section">
            <div
              ref="previewStageWrapRef"
              class="preview-stage-wrap"
              :class="{
                'preview-stage-wrap--fullscreen': isPreviewFullscreen,
                'preview-stage-wrap--fullscreen-exit-visible':
                  isPreviewFullscreen && showFullscreenExitButton,
              }"
              @dragenter.prevent="handleVideoDragEnter"
              @dragover.prevent="handleVideoDragOver"
              @dragleave.prevent="handleVideoDragLeave"
              @drop.prevent="handleVideoDrop"
              @mousemove="handleFullscreenHoverMove"
              @mouseleave="handleFullscreenHoverLeave"
            >
              <div
                ref="fullscreenViewportHostRef"
                class="fullscreen-viewport-host"
                @wheel="handleFullscreenViewportWheel"
                @pointerdown="handleFullscreenViewportPointerDown"
              >
                <CanvasPlayer
                  ref="canvasPlayerRef"
                  class="player-canvas"
                  :viewport-scale="activeFullscreenViewportScale"
                  :viewport-offset-x="activeFullscreenViewportOffsetX"
                  :viewport-offset-y="activeFullscreenViewportOffsetY"
                >
                  <template #overlay>
                    <VideoPreviewOverlay
                      ref="videoOverlayRef"
                      v-if="videoStore.hasVideoFile && videoStore.displayWidth && videoStore.displayHeight"
                      :display-width="videoStore.displayWidth"
                      :display-height="videoStore.displayHeight"
                      :source-width="videoStore.videoWidth"
                      :source-height="videoStore.videoHeight"
                      :current-model="currentModel"
                      :disabled="isProcessing || samVideoState.running"
                      :preview-visible="fullscreenMaskPreviewVisible"
                      :allow-mask-transform="!isFullscreenLamaViewportMode && !isFullscreenSamViewportMode"
                      @draw-start="handleFullscreenDrawStart"
                      @draw-end="handleFullscreenDrawEnd"
                      @sam-prompt="handleSamVideoPromptFromOverlay"
                    />
                  </template>
                </CanvasPlayer>
              </div>

              <MaskFloatingToolbar
                v-if="isFullscreenLamaViewportMode"
                ref="fullscreenDrawingToolbarRef"
                :show="showFullscreenDrawingToolbar"
                :position="fullscreenDrawingToolbarPosition"
                :drawing-enabled="videoStore.maskTool.drawingEnabled"
                :mode="videoStore.maskTool.mode"
                :brush-size="videoStore.maskTool.brushSize"
                :brush-color="videoStore.maskTool.brushColor"
                :brush-alpha="videoStore.maskTool.brushAlpha"
                :can-undo="videoStore.canUndoSelectedMaskDraw"
                :can-clear="selectedMaskIsEditableStandard"
                :disabled="!selectedMaskIsEditableStandard || isProcessing || samVideoState.running"
                drag-label="绘制工具拖动区域"
                @drag-start="startFullscreenDrawingToolbarDrag"
                @toggle-drawing="
                  videoStore.updateMaskTool({
                    drawingEnabled: !videoStore.maskTool.drawingEnabled,
                  })
                "
                @update:mode="videoStore.updateMaskTool({ mode: $event })"
                @update:brush-size="videoStore.updateMaskTool({ brushSize: $event })"
                @update:brush-color="videoStore.updateMaskTool({ brushColor: $event })"
                @update:brush-alpha="videoStore.updateMaskTool({ brushAlpha: $event })"
                @undo="videoStore.undoSelectedMaskDraw()"
                @clear="clearSelectedMaskForFullscreenToolbar"
                @reset-view="resetFullscreenViewport"
                @hold-mask-visibility="setFullscreenMaskPreviewVisible"
              />

              <div
                v-if="isFullscreenSamViewportMode"
                ref="fullscreenDrawingToolbarRef"
                v-show="showFullscreenDrawingToolbar"
                class="sam-video-floating-toolbar toolbar-container app-floating-toolbar"
                :style="fullscreenSmartToolbarStyle"
                @mousedown.stop
                @pointerdown.stop
              >
                <div
                  class="toolbar-handle bg-primary text-white text-center text-xs py-1 cursor-move"
                  @pointerdown.stop.prevent="startFullscreenDrawingToolbarDrag"
                >
                  智能选区工具拖动区域
                </div>
                <q-bar class="sam-video-floating-toolbar__bar rounded-b-pill">
                  <div class="sam-video-floating-toolbar__controls">
                    <q-btn-group flat class="sam-video-tool-group rounded-pill overflow-hidden">
                      <q-btn
                        color="primary"
                        text-color="white"
                        icon="tune"
                        aria-label="智能选区设置"
                        title="智能选区设置"
                        data-testid="video-sam-fullscreen-settings-button"
                      >
                        <q-tooltip>智能选区设置</q-tooltip>
                        <q-menu
                          anchor="bottom middle"
                          self="top middle"
                          :offset="[0, 10]"
                          content-class="video-sam-settings-popup"
                        >
                          <div class="video-sam-settings-panel q-pa-md">
                            <div class="video-sam-popup-header">
                              <div class="video-sam-settings-title">智能选区设置</div>
                              <q-btn
                                flat
                                round
                                dense
                                icon="close"
                                v-close-popup
                                data-testid="video-sam-fullscreen-settings-close-button"
                              >
                                <q-tooltip>关闭</q-tooltip>
                              </q-btn>
                            </div>
                            <q-select
                              v-model="samVideoSessionModelId"
                              dense
                              outlined
                              emit-value
                              map-options
                              :options="samVideoModelOptions"
                              label="智能选区模型"
                              data-testid="video-sam-fullscreen-model-select"
                              :disable="samVideoState.running"
                            />
                            <div class="video-sam-settings-item">
                              <div class="text-caption text-grey-7">点选/框选能力</div>
                              <div class="text-body2">
                                {{
                                  activeSamVideoSupportsPoint && activeSamVideoSupportsBox
                                    ? "支持点选和框选"
                                    : activeSamVideoSupportsBox
                                    ? "支持框选"
                                    : activeSamVideoSupportsPoint
                                    ? "支持点选"
                                    : "当前模型不支持点选/框选"
                                }}
                              </div>
                            </div>
                            <template v-if="activeSamVideoSupportsText">
                              <q-separator />
                              <q-input
                                v-model="samVideoTextPrompt"
                                dense
                                outlined
                                clearable
                                label="文本智选"
                                placeholder="输入目标，例如 person"
                                data-testid="video-sam-fullscreen-text-input"
                                :disable="samVideoState.running"
                              />
                              <div class="sam-lexicon-row">
                                <q-select
                                  v-model="samVideoTextColor"
                                  dense
                                  outlined
                                  clearable
                                  emit-value
                                  map-options
                                  :options="samVideoTextColorOptions"
                                  label="颜色"
                                  class="sam-lexicon-select"
                                  :disable="samVideoState.running"
                                />
                                <q-select
                                  v-model="samVideoTextNoun"
                                  dense
                                  outlined
                                  clearable
                                  use-input
                                  emit-value
                                  map-options
                                  :options="samVideoTextNounOptions"
                                  label="目标"
                                  class="sam-lexicon-select"
                                  :disable="samVideoState.running"
                                  @filter="filterSamVideoTextNounOptions"
                                />
                              </div>
                              <div v-if="samVideoGeneratedPromptText" class="text-caption text-grey-7">
                                {{ samVideoGeneratedPromptText }}
                              </div>
                              <q-btn
                                color="primary"
                                icon="manage_search"
                                label="文本智选"
                                no-caps
                                unelevated
                                data-testid="video-sam-fullscreen-text-run-button"
                                :loading="samVideoState.running"
                                :disable="!canRunSamVideoTextPropagation"
                                @click="runSamVideoTextPropagation"
                              />
                            </template>
                          </div>
                        </q-menu>
                      </q-btn>
                      <q-btn
                        color="primary"
                        text-color="white"
                        icon="ads_click"
                        :disable="!activeSamVideoSupportsPoint && !activeSamVideoSupportsBox"
                        :aria-label="samVideoSelectToolTooltip"
                        :title="samVideoSelectToolTooltip"
                        data-testid="video-sam-fullscreen-select-tool-button"
                      >
                        <q-tooltip>{{ samVideoSelectToolTooltip }}</q-tooltip>
                      </q-btn>
                      <q-btn
                        icon="format_list_bulleted"
                        :text-color="$q.dark.isActive ? 'grey-2' : 'grey-8'"
                        aria-label="候选蒙版列表"
                        title="候选蒙版列表"
                        data-testid="video-sam-fullscreen-candidate-button"
                      >
                        <q-tooltip>候选蒙版列表</q-tooltip>
                        <q-menu
                          v-model="samVideoCandidateMenuOpen"
                          anchor="bottom middle"
                          self="top middle"
                          :offset="[0, 10]"
                          content-class="video-sam-candidate-popup"
                        >
                          <div class="video-sam-candidate-panel q-pa-sm">
                            <div class="video-sam-popup-header video-sam-popup-header--compact q-px-sm q-pt-xs">
                              <div class="video-sam-settings-title">候选蒙版</div>
                              <q-btn
                                flat
                                round
                                dense
                                icon="close"
                                v-close-popup
                                data-testid="video-sam-fullscreen-candidate-close-button"
                              >
                                <q-tooltip>关闭</q-tooltip>
                              </q-btn>
                            </div>
                            <q-list dense separator class="sam-track-object-list">
                              <q-item
                                v-for="objectItem in selectedSamVideoResultObjects"
                                :key="`fullscreen-sam-object-${objectItem.objectId}`"
                              >
                                <q-item-section>
                                  <q-item-label>对象 {{ objectItem.objectId }}</q-item-label>
                                  <q-item-label caption>
                                    {{ objectItem.enabled === false ? "已隐藏" : "已启用" }} ·
                                    {{ objectItem.hasBox ? "框选传播" : "点选传播" }}
                                  </q-item-label>
                                </q-item-section>
                                <q-item-section side>
                                  <div class="row items-center no-wrap q-gutter-xs">
                                    <q-toggle
                                      dense
                                      :model-value="objectItem.enabled !== false"
                                      :disable="samVideoState.running"
                                      :aria-label="objectItem.enabled === false ? '显示候选对象' : '隐藏候选对象'"
                                      :title="objectItem.enabled === false ? '显示候选对象' : '隐藏候选对象'"
                                      @update:model-value="
                                        (value) =>
                                          videoStore.setSamVideoObjectEnabled(
                                            videoStore.selectedMaskId,
                                            objectItem.objectId,
                                            value
                                          )
                                      "
                                    />
                                    <q-input
                                      v-if="currentModelRequiresMask"
                                      :model-value="objectItem.expandPx ?? objectItem.autoExpandPx ?? 0"
                                      type="number"
                                      dense
                                      outlined
                                      min="0"
                                      max="99"
                                      step="1"
                                      suffix="px"
                                      class="video-sam-object-expand-input"
                                      input-class="text-center"
                                      :disable="samVideoState.running"
                                      @update:model-value="setSelectedSamVideoObjectExpandPx(objectItem.objectId, $event)"
                                      @click.stop
                                    >
                                      <q-tooltip>LaMa 扩边大小</q-tooltip>
                                    </q-input>
                                    <q-btn
                                      flat
                                      round
                                      dense
                                      color="negative"
                                      icon="delete"
                                      :disable="samVideoState.running"
                                      @click="removeSelectedSamVideoObject(objectItem.objectId)"
                                    >
                                      <q-tooltip>删除候选对象</q-tooltip>
                                    </q-btn>
                                  </div>
                                </q-item-section>
                              </q-item>
                              <q-item v-if="selectedSamVideoResultObjects.length === 0">
                                <q-item-section class="text-grey-6">
                                  还没有候选对象。先在画面上点选/框选目标，再运行智能选区。
                                </q-item-section>
                              </q-item>
                            </q-list>
                          </div>
                        </q-menu>
                      </q-btn>
                    </q-btn-group>
                    <q-btn
                      flat
                      round
                      dense
                      icon="clear"
                      color="primary"
                      :disable="!hasSelectedSamVideoState"
                      aria-label="清空提示、候选对象和传播结果"
                      title="清空提示、候选对象和传播结果"
                      data-testid="video-sam-fullscreen-clear-button"
                      @click="clearSelectedSamVideoResult"
                    >
                      <q-tooltip>清空提示、候选对象和传播结果</q-tooltip>
                    </q-btn>
                    <q-btn
                      flat
                      round
                      dense
                      icon="auto_fix_high"
                      color="primary"
                      :loading="samVideoState.running"
                      :disable="!canRunSamVideoPropagation"
                      aria-label="运行智能选区"
                      title="运行智能选区"
                      @click="runSamVideoPropagation"
                    >
                      <q-tooltip>运行智能选区</q-tooltip>
                    </q-btn>
                    <q-btn
                      flat
                      round
                      dense
                      icon="center_focus_strong"
                      color="primary"
                      aria-label="重置视图"
                      title="重置视图"
                      @click="resetFullscreenViewport"
                    >
                      <q-tooltip>重置视图</q-tooltip>
                    </q-btn>
                    <q-btn
                      flat
                      round
                      dense
                      icon="visibility_off"
                      color="primary"
                      aria-label="按住隐藏全部蒙版"
                      title="按住隐藏全部蒙版"
                      data-testid="video-sam-fullscreen-hold-hide-button"
                      @mousedown.prevent="setFullscreenMaskPreviewVisible(false)"
                      @mouseup.prevent="setFullscreenMaskPreviewVisible(true)"
                      @mouseleave="setFullscreenMaskPreviewVisible(true)"
                      @touchstart.prevent="setFullscreenMaskPreviewVisible(false)"
                      @touchend.prevent="setFullscreenMaskPreviewVisible(true)"
                      @touchcancel.prevent="setFullscreenMaskPreviewVisible(true)"
                    >
                      <q-tooltip>按住隐藏全部蒙版</q-tooltip>
                    </q-btn>
                  </div>
                </q-bar>
              </div>

              <div
                v-if="isPreviewFullscreen"
                class="fullscreen-exit-overlay"
                @mouseenter="showFullscreenExitOverlay"
                @mouseleave="handleFullscreenHoverLeave"
              >
                <q-btn
                  unelevated
                  no-caps
                  color="primary"
                  icon="fullscreen_exit"
                  label="退出全屏"
                  class="fullscreen-exit-button"
                  @click="togglePreviewFullscreen"
                />
              </div>

              <div
                v-if="isPreviewFullscreen"
                class="fullscreen-bottom-controls"
                :class="{ 'is-visible': showFullscreenBottomControls }"
                @mouseenter="showFullscreenBottomOverlay"
                @mouseleave="scheduleHideFullscreenBottomOverlay()"
              >
                <div class="fullscreen-bottom-controls-row">
                  <div class="fullscreen-progress-control">
                    <q-slider
                      v-model="currentProgress"
                      class="timeline-progress-slider"
                      :min="0"
                      :max="Math.max(videoStore.videoDuration, 0.001)"
                      :step="0.001"
                      :disable="fullscreenControlsDisabled"
                      @update:model-value="handleProgressChange"
                      @pan="handleProgressDrag"
                      color="primary"
                      track-size="6px"
                      track-color="grey-4"
                      thumb-color="primary"
                    />
                    <span class="timeline-time-display timeline-time-display--dark">
                      {{ timelineTimeText }}
                    </span>
                  </div>

                  <q-btn
                    round
                    dense
                    flat
                    color="primary"
                    :icon="videoStore.isPlaying ? 'pause' : 'play_arrow'"
                    :disable="fullscreenControlsDisabled"
                    @click="handlePlayPause"
                  >
                    <q-tooltip>{{ videoStore.isPlaying ? "Pause" : "Play" }}</q-tooltip>
                  </q-btn>

                  <q-btn-dropdown
                    dense
                    no-caps
                    color="primary"
                    outline
                    class="timeline-playback-dropdown"
                    :label="`${videoStore.playbackRate}x`"
                    :disable="fullscreenControlsDisabled"
                  >
                    <q-list>
                      <q-item
                        v-for="rate in playbackRates"
                        :key="`fullscreen-rate-${rate}`"
                        clickable
                        v-close-popup
                        @click="handlePlaybackRateChange(rate)"
                        :class="{ 'bg-primary text-white': rate === videoStore.playbackRate }"
                      >
                        <q-item-section>
                          <q-item-label>{{ rate }}x</q-item-label>
                        </q-item-section>
                      </q-item>
                    </q-list>
                  </q-btn-dropdown>

                  <q-btn
                    round
                    dense
                    flat
                    :color="videoStore.isMuted ? 'negative' : 'primary'"
                    :icon="videoStore.isMuted ? 'volume_off' : 'volume_up'"
                    :disable="fullscreenControlsDisabled"
                    @click="handleToggleMute"
                  >
                    <q-tooltip>{{ videoStore.isMuted ? "Unmute" : "Mute" }}</q-tooltip>
                  </q-btn>

                  <q-btn
                    v-if="isPreviewFullscreen"
                    round
                    dense
                    flat
                    color="primary"
                    :icon="fullscreenToolbarToggleIcon"
                    :disable="fullscreenDrawingToolbarToggleDisabled"
                    @click="handleFullscreenDrawingToolbarToggle"
                  >
                    <q-tooltip>{{ fullscreenToolbarToggleTooltipText }}</q-tooltip>
                  </q-btn>
                </div>
              </div>
            </div>
          </q-card-section>
        </q-card>

        <q-card class="right-panel">
          <q-card-section class="side-panel-body">
            <VideoMaskEditor
              :disabled="!videoStore.hasVideoFile || isProcessing"
              :current-model="currentModel"
              :section-state="videoEditorSections"
              :sam-video-running="samVideoState.running"
              :sam-video-progress="samVideoState.progress"
              :sam-video-message="samVideoState.message"
              :sam-video-error="samVideoState.error"
              :has-sam-video-result="hasSelectedSamVideoState"
              :can-run-sam-video="canRunSamVideoPropagation"
              :sam-video-model-options="samVideoModelOptions"
              :sam-video-model-id="activeSamVideoModelId"
              :sam-video-supports-point="activeSamVideoSupportsPoint"
              :sam-video-supports-box="activeSamVideoSupportsBox"
              :sam-video-supports-text="activeSamVideoSupportsText"
              :sam-video-text-prompt="samVideoTextPrompt"
              :sam-video-text-color="samVideoTextColor"
              :sam-video-text-noun="samVideoTextNoun"
              :sam-video-text-color-options="samVideoTextColorOptions"
              :sam-video-text-noun-options="samVideoTextNounOptions"
              :sam-video-generated-prompt-text="samVideoGeneratedPromptText"
              :can-run-sam-video-text="canRunSamVideoTextPropagation"
              @update:section-state="videoEditorSections = $event"
              @update:sam-video-model-id="samVideoSessionModelId = $event"
              @update:sam-video-text-prompt="samVideoTextPrompt = $event"
              @update:sam-video-text-color="samVideoTextColor = $event"
              @update:sam-video-text-noun="samVideoTextNoun = $event"
              @filter-sam-video-text-nouns="filterSamVideoTextNounOptions"
              @run-sam-video-text="runSamVideoTextPropagation"
              @run-sam-video-selection="runSamVideoPropagation"
              @clear-sam-video-result="clearSelectedSamVideoResult"
              @remove-sam-video-object="removeSelectedSamVideoObject"
            />
          </q-card-section>
        </q-card>
      </div>

      <q-card v-if="videoStore.hasVideoFile" class="timeline-panel">
        <q-card-section
          class="timeline-controls"
          :class="{ 'timeline-controls-disabled': timelineControlsDisabled }"
        >
          <div class="timeline-controls-scroll">
            <div class="timeline-controls-row">
              <q-btn
                round
                dense
                flat
                color="primary"
                icon="stop"
                :disable="timelineControlsDisabled"
                @click="handleStop"
              >
                <q-tooltip>Stop</q-tooltip>
              </q-btn>

              <q-btn
                round
                dense
                flat
                color="primary"
                icon="fast_rewind"
                :disable="timelineControlsDisabled"
                @click="handlePreviousFrame"
              >
                <q-tooltip>Prev Frame</q-tooltip>
              </q-btn>

              <q-btn
                round
                dense
                flat
                color="primary"
                :icon="videoStore.isPlaying ? 'pause' : 'play_arrow'"
                :disable="timelineControlsDisabled"
                @click="handlePlayPause"
              >
                <q-tooltip>{{ videoStore.isPlaying ? "Pause" : "Play" }}</q-tooltip>
              </q-btn>

              <q-btn
                round
                dense
                flat
                color="primary"
                icon="fast_forward"
                :disable="timelineControlsDisabled"
                @click="handleNextFrame"
              >
                <q-tooltip>Next Frame</q-tooltip>
              </q-btn>

              <div class="timeline-progress-control">
                <q-slider
                  v-model="currentProgress"
                  class="timeline-progress-slider"
                  :min="0"
                  :max="Math.max(videoStore.videoDuration, 0.001)"
                  :step="0.001"
                  :disable="timelineControlsDisabled"
                  @update:model-value="handleProgressChange"
                  @pan="handleProgressDrag"
                  color="primary"
                  track-size="6px"
                  track-color="grey-4"
                  thumb-color="primary"
                />
                <span
                  class="timeline-time-display"
                  :class="
                    $q.dark.isActive ? 'timeline-time-display--dark' : 'timeline-time-display--light'
                  "
                >
                  {{ timelineTimeText }}
                </span>
              </div>

              <q-btn-dropdown
                dense
                no-caps
                color="primary"
                outline
                class="timeline-playback-dropdown"
                :label="`${videoStore.playbackRate}x`"
                :disable="timelineControlsDisabled"
              >
                <q-list>
                  <q-item
                    v-for="rate in playbackRates"
                    :key="rate"
                    clickable
                    v-close-popup
                    @click="handlePlaybackRateChange(rate)"
                    :class="{ 'bg-primary text-white': rate === videoStore.playbackRate }"
                  >
                    <q-item-section>
                      <q-item-label>{{ rate }}x</q-item-label>
                    </q-item-section>
                  </q-item>
                </q-list>
              </q-btn-dropdown>

              <q-btn
                round
                dense
                flat
                color="primary"
                :icon="isPreviewFullscreen ? 'fullscreen_exit' : 'fullscreen'"
                :disable="timelineControlsDisabled"
                @click="togglePreviewFullscreen"
              >
                <q-tooltip>{{ isPreviewFullscreen ? "Exit Fullscreen" : "Fullscreen" }}</q-tooltip>
              </q-btn>

              <q-btn
                round
                dense
                flat
                :color="videoStore.isMuted ? 'negative' : 'primary'"
                :icon="videoStore.isMuted ? 'volume_off' : 'volume_up'"
                :disable="timelineControlsDisabled"
                @click="handleToggleMute"
              >
                <q-tooltip>{{ videoStore.isMuted ? "Unmute" : "Mute" }}</q-tooltip>
              </q-btn>

              <div class="timeline-zoom-control">
                <q-btn
                  round
                  dense
                  flat
                  color="primary"
                  icon="zoom_out"
                  :disable="timelineZoomDisabled"
                  @click="decreaseTimelineZoom"
                >
                  <q-tooltip>Zoom Out</q-tooltip>
                </q-btn>
                <q-slider
                  v-model="timelineZoomPercent"
                  class="timeline-zoom-slider"
                  :min="0"
                  :max="100"
                  :step="timelineZoomStep"
                  :disable="timelineZoomDisabled"
                  color="primary"
                  track-size="6px"
                  track-color="grey-4"
                  thumb-color="primary"
                />
                <q-btn
                  round
                  dense
                  flat
                  color="primary"
                  icon="zoom_in"
                  :disable="timelineZoomDisabled"
                  @click="increaseTimelineZoom"
                >
                  <q-tooltip>Zoom In</q-tooltip>
                </q-btn>
              </div>
            </div>
          </div>
        </q-card-section>
        <q-card-section class="timeline-wrap" :class="{ 'timeline-disabled': isProcessing || samVideoState.running }">
          <div ref="timelineViewportRef" class="timeline-editor-host">
          <TimelineEditor
            ref="timelineRef"
            :model-value="timelineRows"
            :effects="timelineEffects"
            :options="timelineOptions"
            :auto-scroll="true"
             @update:model-value="handleTimelineModelChange"
             @time-update="handleTimelineTimeUpdate"
             @scroll="handleTimelineScroll"
             @click-action="handleTimelineActionClick"
             @action-move-end="handleTimelineActionMoveEnd"
             @action-resize-end="handleTimelineActionResizeEnd"
           >
            <template #action="{ action }">
              <div
                class="timeline-action"
                :class="{
                  'timeline-action-range': action.data?.kind === 'mask-range',
                  'timeline-action-processing-range': action.data?.kind === 'processing-range',
                  'timeline-action-keyframe': action.data?.kind === 'mask-keyframe',
                }"
              >
                <span v-if="['mask-range', 'processing-range'].includes(action.data?.kind)">
                  {{ action.data?.label || action.id }}
                </span>
                <span v-else class="keyframe-dot"></span>
              </div>
            </template>
          </TimelineEditor>
          </div>
        </q-card-section>
      </q-card>
    </div>

    <q-dialog v-model="samCpuRiskDialogOpen" persistent class="sam-cpu-risk-dialog">
      <q-card class="sam-cpu-risk-card">
        <q-card-section>
          <div class="text-subtitle1 text-weight-medium">CPU 运行风险确认</div>
          <div class="q-mt-sm text-body2">
            本功能建议使用CUDA启动，当前使用CPU启动，可能导致使用过程中CPU资源占用过多、设备卡顿明显等现象，您确认使用CPU启动吗？
          </div>
          <q-checkbox
            v-model="samCpuRiskAcknowledged"
            class="q-mt-md"
            dense
            label="我已知晓，且承诺自行承担风险。"
          />
        </q-card-section>
        <q-card-actions align="right">
          <q-btn flat label="取消" @click="resolveSamCpuRiskDialog(false)" />
          <q-btn
            color="primary"
            label="确认"
            :disable="!samCpuRiskAcknowledged"
            @click="resolveSamCpuRiskDialog(true)"
          />
        </q-card-actions>
      </q-card>
    </q-dialog>
  </q-page>
</template>

<script setup>
import { computed, inject, nextTick, onMounted, onUnmounted, reactive, ref, watch } from "vue";
import { useQuasar } from "quasar";
import { onBeforeRouteLeave } from "vue-router";
import TimelineEditor from "vue-timeline-editor";
import "vue-timeline-editor/dist/vue-timeline-editor.css";
import {
  Combinator,
  MP4Clip,
  OffscreenSprite,
  fastConcatMP4,
  mixinMP4AndAudio,
} from "@webav/av-cliper";

import { useConfigStore } from "src/stores/config";
import { useAppStateStore } from "src/stores/appState";
import { useConfiguredShortcuts } from "src/composables/useConfiguredShortcuts";
import { useModelRegistryStore } from "src/stores/modelRegistry";
import { useRuntimeDiagnosticsStore } from "src/stores/runtimeDiagnostics";
import { useVideoManagerStore } from "src/stores/videoManager";
import { submitVideoBatchInpaint } from "src/services/VideoProcessingService";
import {
  createSamVideoPropagationJob,
  getSamVideoPropagationJob,
  getSamVideoPropagationJobResult,
} from "src/services/SamPredictionService";
import {
  buildSam3LexiconPrompt,
  loadSam3Lexicon,
} from "src/services/SamLexiconService";
import { MASK_TOOL_MODES } from "src/utils/maskTool";
import {
  formatSeconds,
  getVideoCenterAnchor,
  getInterpolatedMaskTransform,
  loadImageElement,
  MASK_KEYFRAME_TYPES,
  sortMaskKeyframes,
} from "src/utils/videoMaskUtils";
import {
  buildProcessingConfigSnapshot,
  createEmptyVideoProcessingRegistry,
  findLatestResumableTaskSummary,
  hasProcessingConfigMismatch,
  isResumableVideoTaskStatus,
  normalizeVideoProcessingRegistry,
  normalizeVideoTaskMeta,
  removeVideoProcessingRegistryTask,
  upsertVideoProcessingRegistryTask,
  VIDEO_TASK_DIRECTORY_PREFIX,
  VIDEO_TASK_META_FILE_NAME,
} from "src/utils/videoProcessingResume";
import {
  buildBackendPathBlockedMessage,
  validateBackendPathsForConfig,
} from "src/utils/backendPathValidation";
import {
  inspectSamMaskPixels,
  normalizeSamExpandRadius,
  resolveSamAutoExpandRadius,
  expandSamMaskImageDataForLama,
} from "src/utils/samMaskAutoExpand";
import {
  clearActiveProcessingTask,
  setActiveProcessingTask,
} from "src/utils/processingTaskGuard";

import CanvasPlayer from "src/components/video/CanvasPlayer.vue";
import ResourceManage from "src/components/video/ResourceManage.vue";
import VideoMaskEditor from "src/components/video/VideoMaskEditor.vue";
import VideoPreviewOverlay from "src/components/video/VideoPreviewOverlay.vue";
import MaskFloatingToolbar from "src/components/common/MaskFloatingToolbar.vue";

const $q = useQuasar();
const videoStore = useVideoManagerStore();
const configStore = useConfigStore();
const appStateStore = useAppStateStore();
const modelRegistryStore = useModelRegistryStore();
const runtimeDiagnosticsStore = useRuntimeDiagnosticsStore();
const loadingControl = inject("loadingControl", null);
const backendRunningState = inject("backendRunning", ref(false));
const backendEngine = inject("backendEngine", ref({}));
const globalSettings = inject("globalSettings", null);

const previewStageWrapRef = ref(null);
const fullscreenViewportHostRef = ref(null);
const fullscreenDrawingToolbarRef = ref(null);
const canvasPlayerRef = ref(null);
const timelineRef = ref(null);
const timelineViewportRef = ref(null);
const videoOverlayRef = ref(null);

const currentProgress = ref(0);
const isDragging = ref(false);
const isProcessing = ref(false);
const VIDEO_PROCESSING_TASK_ID = "video-processing";
const processingSucceeded = ref(false);
const processingProgress = ref(0);
const processingMessage = ref("");
const VIDEO_PROCESSING_PHASES = Object.freeze({
  IDLE: "idle",
  PREPARING: "preparing",
  STAGING: "staging",
  BACKEND: "backend",
  ENCODING: "encoding",
  FINALIZING: "finalizing",
  WRITING: "writing",
  COMPLETE: "complete",
  FAILED: "failed",
});
const processingPhase = ref(VIDEO_PROCESSING_PHASES.IDLE);
const lastOutputPath = ref("");
const lastOutputIsPreview = ref(false);
const exportFpsMode = ref("source");
const previewTrialSeconds = ref(3);
const currentModel = ref("lama");
const VIDEO_PROCESSING_MODEL_IDS = ["lama", "mat", "slbr"];
const MASK_INPAINT_MODEL_IDS = ["lama", "mat"];
const MAT_CUDA_FALLBACK_MESSAGE = "MAT 需要 CUDA，当前已自动切换为 LaMa。";
const modelParameterValues = ref({});
const resourceManageTab = ref("info");
const videoEditorSections = ref({
  brush: true,
  range: false,
  keyframes: true,
  processingRange: true,
});
const samVideoSessionModelId = ref("");
const samVideoTextPrompt = ref("");
const samVideoTextColor = ref("");
const samVideoTextNoun = ref("");
const samVideoTextLexicon = ref({ colors: [], nouns: [] });
const samVideoTextFilteredNouns = ref([]);
const samCpuRiskDialogOpen = ref(false);
const samCpuRiskAcknowledged = ref(false);
let samCpuRiskDialogResolve = null;
const samVideoState = reactive({
  running: false,
  progress: 0,
  message: "",
  error: "",
  frameIndex: 0,
  maxFrames: 24,
  lastResultSummary: null,
  lastTrackId: "",
});
const SAM_VIDEO_MASK_ASSET_DIRECTORY = "moonshine-sam-video-masks";
const DISK_SPACE_SAFETY_BYTES = 64 * 1024 * 1024;
const VIDEO_DISK_ESTIMATE_FACTORS = Object.freeze({
  sourceCopyMultiplier: 1.05,
  frameBytesPerPixel: 0.24,
  maskBytesPerPixel: 0.12,
  resultBytesPerPixel: 0.32,
  segmentBytesPerPixel: 0.18,
  finalVideoMultiplier: 1.2,
  samMaskBytesPerPixel: 0.18,
});
const sourceFps = ref(30);
const timelineRows = ref([]);
const timelineViewportWidth = ref(0);
const timelineScrollLeft = ref(0);
const timelineZoomPercent = ref(0);
const videoDropDepth = ref(0);
const isPreviewFullscreen = ref(false);
const showFullscreenExitButton = ref(false);
const showFullscreenBottomControls = ref(false);
const showFullscreenDrawingToolbar = ref(false);
const samVideoCandidateMenuOpen = ref(false);
const fullscreenMaskPreviewVisible = ref(true);
const fullscreenViewportState = ref({
  scale: 1,
  offsetX: 0,
  offsetY: 0,
});
const fullscreenDrawingToolbarPosition = ref({
  x: 24,
  y: 24,
});

let syncingTimelineFromStore = false;
let processingEtaTickerId = null;
let processingBatchMessageContext = null;
let preserveLastOutputPathOnNextVideoChange = false;
let previewStageResizeObserver = null;
let pendingLayoutFrameId = 0;
let cachedVideoProcessingRegistryPath = "";
let suppressSourceCleanupWatcher = false;
let previewFullscreenExitTimerId = 0;
let previewFullscreenBottomControlsTimerId = 0;
let fullscreenZoomSessionTimerId = 0;
let canPersistVideoUiState = false;
let fullscreenDrawingToolbarDragContext = null;
let fullscreenViewportPanContext = null;
const fullscreenPlaybackPauseSessions = new Map();
let fullscreenPlaybackResumeRequested = false;
const playbackRates = [0.5, 1, 1.5, 2, 3];
const timelineScaleWidth = 160;
const timelineStartLeft = 20;
const timelineZoomStep = 5;
const VIDEO_READY_TIMEOUT_MS = 30000;
const PROCESSING_ETA_TICK_MS = 250;
const PROCESSING_FINAL_STAGE_PLACEHOLDER_SECONDS = 5;
const FINAL_CONCAT_GROUP_SIZE = 8;
const FINAL_CONCAT_PROGRESS_BASE = 0.9;
const FINAL_CONCAT_NO_AUDIO_PROGRESS_SPAN = 0.08;
const FINAL_CONCAT_WITH_AUDIO_PROGRESS_SPAN = 0.05;
const FINAL_AUDIO_MIX_PROGRESS = 0.95;
const VIDEO_PREVIEW_TRIAL_DURATIONS = [3, 10];
const PROCESSING_ETA_MODES = {
  DYNAMIC: "dynamic",
  FREEZE: "freeze",
};
const VIDEO_MOUNT_LOADING_PROGRESS = Object.freeze({
  PREPARE: 0.18,
  PREVIEW: 0.62,
  TIMELINE: 0.88,
  FINALIZE: 0.97,
});

const processingEtaState = {
  firstResponseSeconds: null,
  estimateBaseSeconds: null,
  estimateFloorSeconds: 0,
  estimateStartedAtMs: 0,
  frozenSeconds: null,
  progressAwareCapSeconds: null,
  progressAwareFloorSeconds: null,
  progressAwareStageBaseSeconds: null,
  sessionStartedAtMs: 0,
};
const videoMountLoadingState = {
  token: 0,
  externallyManaged: false,
};

const timelineEffects = {
  "effect-mask-range": { id: "effect-mask-range", name: "Mask Range" },
  "effect-mask-keyframe": { id: "effect-mask-keyframe", name: "Keyframe" },
  "effect-processing-range": { id: "effect-processing-range", name: "Processing Range" },
};

const fpsOptions = computed(() => [
  { label: `跟随源视频（估算 ${sourceFps.value} fps）`, value: "source" },
  { label: "24 fps", value: "24" },
  { label: "30 fps", value: "30" },
  { label: "60 fps", value: "60" },
]);

const previewTrialOptions = computed(() =>
  VIDEO_PREVIEW_TRIAL_DURATIONS.map((seconds) => ({
    label: `${seconds} 秒样片`,
    value: seconds,
  }))
);

const exportFps = computed(() => {
  if (exportFpsMode.value === "source") return sourceFps.value;
  return Number(exportFpsMode.value) || sourceFps.value;
});

const historyEntries = computed(() => [...videoStore.videoHistory].reverse());
const canReplaceCurrentSource = computed(
  () => Boolean(lastOutputPath.value) && processingSucceeded.value && !lastOutputIsPreview.value
);
const canOpenOutput = computed(
  () =>
    Boolean(lastOutputPath.value) &&
    (processingSucceeded.value ||
      (Boolean(videoStore.currentSourceIsReplacement) && videoStore.videoHistory.length > 0))
);
const getSamEnabledCapability = (model, ...capabilities) => {
  const enabledCapabilities = model?.enabledCapabilities;
  if (!enabledCapabilities || typeof enabledCapabilities !== "object") return null;
  return capabilities.some((capability) => enabledCapabilities[capability] === true);
};
const samVideoRuntimeDevice = computed(() => {
  if (configStore.config.general?.launchMode !== "cuda") {
    return "cpu";
  }
  if (!runtimeDiagnosticsStore.hasCudaStatus || runtimeDiagnosticsStore.cudaRefreshing) {
    return "cuda";
  }
  return runtimeDiagnosticsStore.cudaAvailable ? "cuda" : "cpu";
});
const isSam3VideoModel = (model = {}) => String(model.family || "").toLowerCase() === "sam3";
const getRuntimeSamVideoCapabilities = (model = {}) => {
  const capabilities = { ...(model.enabledCapabilities || {}) };
  if (isSam3VideoModel(model) && samVideoRuntimeDevice.value !== "cuda") {
    capabilities.videoPoint = false;
    capabilities.videoBox = false;
    capabilities.videoText = false;
    capabilities.videoPropagate = false;
  }
  return capabilities;
};
const supportsVideoSmartSelection = (model) => {
  const runtimeModel = {
    ...model,
    enabledCapabilities: getRuntimeSamVideoCapabilities(model),
  };
  const canPropagate = getSamEnabledCapability(runtimeModel, "videoPropagate");
  const hasVideoPrompt = getSamEnabledCapability(runtimeModel, "videoPoint", "videoBox", "videoText");
  if (canPropagate !== null || hasVideoPrompt !== null) {
    return Boolean(canPropagate && hasVideoPrompt);
  }
  return model?.family === "sam2";
};
const samVideoModelOptions = computed(() =>
  modelRegistryStore.installedMaskModels
    .filter((model) => supportsVideoSmartSelection(model))
    .map((model) => ({
      label: model.label || model.id,
      value: model.id,
      family: model.family,
      enabledCapabilities: getRuntimeSamVideoCapabilities(model),
    }))
);
const defaultSamVideoModelId = computed(() => {
  const configured =
    configStore.config.masking?.videoSmartSelectionDefaultModel ||
    configStore.config.masking?.defaultSam2Model ||
    "sam2_1_hiera_large";
  if (samVideoModelOptions.value.some((option) => option.value === configured)) {
    return configured;
  }
  return samVideoModelOptions.value[0]?.value || configured;
});
const activeSamVideoModelId = computed(() => {
  const selected = String(samVideoSessionModelId.value || "").trim();
  if (samVideoModelOptions.value.some((option) => option.value === selected)) {
    return selected;
  }
  return defaultSamVideoModelId.value;
});
const activeSamVideoModelOption = computed(
  () =>
    samVideoModelOptions.value.find((option) => option.value === activeSamVideoModelId.value) ||
    null
);
const activeSamVideoCapabilities = computed(() => activeSamVideoModelOption.value?.enabledCapabilities || {});
const activeSamVideoSupportsPoint = computed(
  () => activeSamVideoCapabilities.value.videoPoint === true
);
const activeSamVideoSupportsBox = computed(
  () => activeSamVideoCapabilities.value.videoBox === true
);
const activeSamVideoSupportsText = computed(
  () => activeSamVideoCapabilities.value.videoText === true
);
const activeSamVideoSupportsPropagate = computed(
  () => activeSamVideoCapabilities.value.videoPropagate === true
);
const samVideoSelectToolTooltip = computed(() => {
  if (activeSamVideoSupportsPoint.value && activeSamVideoSupportsBox.value) {
    return "点选/框选对象：单击点选，拖拽框选";
  }
  if (activeSamVideoSupportsBox.value) {
    return "框选对象：拖拽框选";
  }
  if (activeSamVideoSupportsPoint.value) {
    return "点选对象：单击点选";
  }
  return "当前模型不支持点选/框选对象";
});
const samVideoTextColorOptions = computed(() =>
  (samVideoTextLexicon.value.colors || []).map((entry) => ({
    label: `${entry.zh} / ${entry.en}`,
    value: entry.zh,
  }))
);
const samVideoTextNounOptions = computed(() =>
  (samVideoTextFilteredNouns.value.length
    ? samVideoTextFilteredNouns.value
    : samVideoTextLexicon.value.nouns || []
  ).map((entry) => ({
    label: `${entry.zh} / ${entry.en}`,
    value: entry.zh,
  }))
);
const selectedSamVideoTextColorEntry = computed(
  () =>
    (samVideoTextLexicon.value.colors || []).find(
      (entry) => entry.zh === samVideoTextColor.value
    ) || null
);
const selectedSamVideoTextNounEntry = computed(
  () =>
    (samVideoTextLexicon.value.nouns || []).find(
      (entry) => entry.zh === samVideoTextNoun.value
    ) || null
);
const samVideoTextPromptSpec = computed(() =>
  buildSam3LexiconPrompt({
    text: samVideoTextPrompt.value,
    color: selectedSamVideoTextColorEntry.value,
    noun: selectedSamVideoTextNounEntry.value,
  })
);
const samVideoGeneratedPromptText = computed(() => {
  const spec = samVideoTextPromptSpec.value;
  if (!spec.text || spec.source === "manual") return "";
  const prefix = spec.source === "lexicon-color" ? "仅颜色：" : "将检索：";
  return `${prefix}${spec.text}${spec.warning ? ` · ${spec.warning}` : ""}`;
});
const canRunSamVideoTextPropagation = computed(
  () =>
    videoStore.hasVideoFile &&
    Boolean(videoStore.videoFile) &&
    activeSamVideoSupportsPropagate.value &&
    activeSamVideoSupportsText.value &&
    !isProcessing.value &&
    !samVideoState.running &&
    Boolean(samVideoTextPromptSpec.value.text)
);

const normalizeSamVideoExpandPx = (value, fallback = 0) =>
  Math.max(
    0,
    Math.min(
      99,
      Math.round(Number.isFinite(Number(value)) ? Number(value) : Number(fallback) || 0)
    )
  );

const proxyDimensions = computed(() => {
  const width = videoStore.videoWidth || 0;
  const height = videoStore.videoHeight || 0;
  const maxSide = configStore.config.video?.proxyMaxSide || 1280;
  if (!width || !height) return { width: 0, height: 0, ratio: 1 };

  const side = Math.max(width, height);
  if (side <= maxSide) return { width, height, ratio: 1 };

  const ratio = maxSide / side;
  return {
    width: Math.round(width * ratio),
    height: Math.round(height * ratio),
    ratio,
  };
});

const previewSizeText = computed(() => {
  if (!videoStore.videoWidth || !videoStore.videoHeight) return "-";

  const width = Math.max(0, Math.round(Number(videoStore.displayWidth || 0)));
  const height = Math.max(0, Math.round(Number(videoStore.displayHeight || 0)));
  if (width > 0 && height > 0) {
    return `${width} x ${height}`;
  }

  return `${proxyDimensions.value.width} x ${proxyDimensions.value.height}`;
});

const exportSizeText = computed(() => {
  if (!videoStore.videoWidth || !videoStore.videoHeight) return "-";
  return `${videoStore.videoWidth} x ${videoStore.videoHeight}`;
});

const keyframeMarkerDuration = computed(() => {
  const duration = Math.max(videoStore.videoDuration || 0, 0.1);
  return Math.min(0.08, Math.max(0.02, duration / 300));
});

const timelineOptions = computed(() => ({
  scale: timelineScale.value,
  scaleSplitCount: 10,
  scaleWidth: timelineScaleWidth,
  startLeft: timelineStartLeft,
  rowHeight: 44,
  minScaleCount: 1,
  duration: Math.max(0.1, videoStore.videoDuration || 0.1),
  gridSnap: true,
  dragLine: true,
  enableRowDrag: false,
  disableDrag: isProcessing.value,
  hideCursor: false,
}));

const timelineControlsDisabled = computed(
  () => !videoStore.hasVideoFile || isProcessing.value
);
const isEditableStandardMask = (mask) =>
  Boolean(mask && mask.type !== "samVideo" && mask.editable !== false);
const hasEditableStandardMaskTrack = computed(() =>
  videoStore.masks.some((mask) => isEditableStandardMask(mask))
);
const selectedMaskIsEditableStandard = computed(() =>
  isEditableStandardMask(videoStore.selectedMask)
);
const selectedMaskIsSamVideo = computed(() => videoStore.selectedMask?.type === "samVideo");
const selectedSamVideoPromptObjects = computed(() =>
  selectedMaskIsSamVideo.value ? videoStore.selectedMask?.samPromptObjects || [] : []
);
const selectedSamVideoResultObjects = computed(() =>
  selectedMaskIsSamVideo.value ? videoStore.selectedMask?.samObjects || [] : []
);
const selectedSamVideoFrames = computed(() =>
  selectedMaskIsSamVideo.value ? videoStore.selectedMask?.samFrames || [] : []
);
const hasSelectedSamVideoState = computed(
  () =>
    selectedSamVideoPromptObjects.value.length > 0 ||
    selectedSamVideoResultObjects.value.length > 0 ||
    selectedSamVideoFrames.value.length > 0
);
const isFullscreenLamaViewportMode = computed(
  () =>
    Boolean(
      isPreviewFullscreen.value &&
        currentModelRequiresMask.value &&
        videoStore.hasVideoFile &&
        selectedMaskIsEditableStandard.value &&
        !samVideoState.running &&
        !isProcessing.value
    )
);
const isFullscreenSamViewportMode = computed(
  () =>
    Boolean(
      isPreviewFullscreen.value &&
        videoStore.hasVideoFile &&
        selectedMaskIsSamVideo.value &&
        !samVideoState.running &&
        !isProcessing.value
    )
);
const activeFullscreenViewportScale = computed(() =>
  isFullscreenLamaViewportMode.value || isFullscreenSamViewportMode.value
    ? Math.max(0.1, Number(fullscreenViewportState.value.scale || 1))
    : 1
);
const activeFullscreenViewportOffsetX = computed(() =>
  isFullscreenLamaViewportMode.value || isFullscreenSamViewportMode.value
    ? Number(fullscreenViewportState.value.offsetX || 0)
    : 0
);
const activeFullscreenViewportOffsetY = computed(() =>
  isFullscreenLamaViewportMode.value || isFullscreenSamViewportMode.value
    ? Number(fullscreenViewportState.value.offsetY || 0)
    : 0
);
const fullscreenSmartToolbarStyle = computed(() => ({
  left: `${Number(fullscreenDrawingToolbarPosition.value.x || 0)}px`,
  top: `${Number(fullscreenDrawingToolbarPosition.value.y || 0)}px`,
  zIndex: 1001,
}));
const fullscreenToolbarToggleIcon = computed(() =>
  showFullscreenDrawingToolbar.value ? "visibility_off" : "visibility"
);
const fullscreenControlsDisabled = computed(
  () => !videoStore.hasVideoFile || isProcessing.value || samVideoState.running
);
const fullscreenToolbarToggleTooltip = computed(() => {
  if (!currentModelRequiresMask.value) {
    return "当前模型无需绘制蒙版";
  }
  if (selectedMaskIsSamVideo.value) {
    return showFullscreenDrawingToolbar.value ? "隐藏智能选区工具" : "显示智能选区工具";
  }
  if (!hasEditableStandardMaskTrack.value) {
    return "请先新建蒙版";
  }
  if (!selectedMaskIsEditableStandard.value) {
    return "请先选择可编辑的蒙版轨道";
  }
  return showFullscreenDrawingToolbar.value ? "隐藏绘制工具栏" : "显示绘制工具栏";
});
const fullscreenToolbarToggleTooltipText = computed(() => fullscreenToolbarToggleTooltip.value);
const fullscreenDrawingToolbarToggleDisabled = computed(
  () =>
    fullscreenControlsDisabled.value ||
    !currentModelRequiresMask.value ||
    !(selectedMaskIsEditableStandard.value || selectedMaskIsSamVideo.value)
);

const maxZoomVisibleDuration = computed(() => {
  const duration = Math.max(Number(videoStore.videoDuration || 0), 0);
  if (!duration) return 0.1;
  const fps = Math.max(Number(videoStore.sourceFrameRate || sourceFps.value || 30), 1);
  return Math.max(Math.min(duration, 30 / fps), 1 / fps);
});

const timelineVisibleDuration = computed(() => {
  if (!videoStore.hasVideoFile) return 0.1;
  const fullDuration = Math.max(Number(videoStore.videoDuration || 0), 0.1);
  const zoomedDuration = maxZoomVisibleDuration.value;
  const zoomRatio = timelineZoomPercent.value / 100;
  return fullDuration - (fullDuration - zoomedDuration) * zoomRatio;
});

const timelineScale = computed(() => {
  const viewportWidth = Math.max(timelineViewportWidth.value - timelineStartLeft, 1);
  const visibleUnits = Math.max(viewportWidth / timelineScaleWidth, 1);
  return Math.max(timelineVisibleDuration.value / visibleUnits, 0.0001);
});

const timelineZoomDisabled = computed(
  () =>
    timelineControlsDisabled.value ||
    Math.abs(Math.max(videoStore.videoDuration || 0, 0.1) - maxZoomVisibleDuration.value) <= 0.0005
);

const timelineTimeText = computed(
  () =>
    `${formatTimelineDuration(videoStore.currentTime)}/${formatTimelineDuration(
      videoStore.videoDuration
    )}`
);

const computedBatchSize = computed(() => {
  const configured = Number(configStore.config.video?.batchFrameCount || 120);
  if (!Number.isFinite(configured)) return 120;
  return Math.max(1, Math.round(configured));
});

const getSupportedVideoExtensions = () =>
  configStore.config.video?.supportedFormats || ["mp4", "mov", "avi", "mkv", "wmv"];

const isSupportedVideoFile = (file) => {
  const extension = String(file?.name || "").split(".").pop()?.toLowerCase();
  return Boolean(extension && getSupportedVideoExtensions().includes(extension));
};

const getVideoFileLocalPath = (file) => {
  if (!file) return "";
  try {
    return (
      window.electron?.ipcRenderer?.getPathForFile?.(file) ||
      file.path ||
      ""
    );
  } catch (error) {
    console.warn("读取视频本地路径失败，后续将使用临时文件兜底:", error);
    return file.path || "";
  }
};

const loadDroppedVideoFile = async (file) => {
  const sourcePath = getVideoFileLocalPath(file);
  await videoStore.setVideoFile(file, {
    resetEditor: true,
    resetHistory: true,
    isReplacementSource: false,
    sourcePath,
    sourceName: file.name || "",
  });
};

const handleVideoDragEnter = (event) => {
  event.dataTransfer.dropEffect = "copy";
  videoDropDepth.value += 1;
};

const handleVideoDragOver = (event) => {
  event.dataTransfer.dropEffect = "copy";
};

const handleVideoDragLeave = () => {
  videoDropDepth.value = Math.max(0, videoDropDepth.value - 1);
};

const handleVideoDrop = async (event) => {
  videoDropDepth.value = 0;
  const files = Array.from(event.dataTransfer?.files || []);
  const videoFile = files.find(isSupportedVideoFile);

  if (!videoFile) {
    $q.notify({
      type: "negative",
      message: `只支持 ${getSupportedVideoExtensions().map((item) => item.toUpperCase()).join(" / ")} 视频文件`,
      position: "top",
    });
    return;
  }

  try {
    await loadDroppedVideoFile(videoFile);
    $q.notify({
      type: "positive",
      message: `已导入视频 ${videoFile.name}`,
      position: "top",
    });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `视频导入失败：${error.message}`,
      position: "top",
    });
  }
};

const handleModelRegistryUpdated = async () => {
  await loadVideoModelOptions({ preferredModel: currentModel.value });
};

const handleGlobalModelSwitch = (event) => {
  const modelId = event?.detail?.modelId;
  if (!modelId || !VIDEO_PROCESSING_MODEL_IDS.includes(modelId)) return;
  void loadVideoModelOptions({ preferredModel: modelId }).then(() => {
    if (videoModelOptions.value.some((option) => option.value === modelId)) {
      handleModelChange(modelId);
    }
  });
};

const backendEngineValue = computed(() => {
  const value = backendEngine?.value || {};
  return {
    isRunning: Boolean(value.isRunning?.value ?? value.isRunning),
    isPreparing: Boolean(value.isPreparing?.value ?? value.isPreparing),
    runDisabled: Boolean(value.runDisabled?.value ?? value.runDisabled),
    runDisabledTooltip: String((value.runDisabledTooltip?.value ?? value.runDisabledTooltip) || ""),
    hasFailed: Boolean(value.hasFailed?.value ?? value.hasFailed),
    openDiagnostics:
      typeof value.openDiagnostics === "function" ? value.openDiagnostics : () => {},
  };
});

const currentModelMetadata = computed(() => {
  const model = modelRegistryStore.imageModels.find((item) => item.id === currentModel.value);
  if (model) return model;
  if (currentModel.value === "slbr") {
    return {
      id: "slbr",
      label: "透明水印去除模型 SLBR",
      installed: false,
      requiresMask: false,
      parameters: {},
      parameterHelp:
        "图片尺寸越大使用越大的分块大小，批次数量影响占用的显存，设备性能和分块大小直接影响处理效果和处理时间，分块大小为256与384的效果一般好于512。",
      corruptFiles: [],
    };
  }
  if (currentModel.value === "mat") {
    return {
      id: "mat",
      label: "MAT 去除模型",
      installed: false,
      available: false,
      requiresMask: true,
      parameters: {},
      parameterHelp: "MAT 需要 CUDA，并使用当前蒙版进行视频逐帧修复。",
      corruptFiles: [],
    };
  }
  return {
    id: "lama",
    label: "Lama去除模型",
    installed: true,
    requiresMask: true,
    parameters: {},
    parameterHelp: "当前模型参数由后端自动控制，无需手动调整。",
    corruptFiles: [],
  };
});
const currentModelRequiresMask = computed(() => currentModelMetadata.value.requiresMask !== false);
const isSlbrModel = computed(() => currentModel.value === "slbr");
const videoModelOptions = computed(() => {
  const options = modelRegistryStore.imageModels
    .filter((model) => VIDEO_PROCESSING_MODEL_IDS.includes(model.id))
    .map((model) => ({
      label: model.label || model.id,
      value: model.id,
      installed: model.installed,
      available: model.available !== false,
      deviceCompatible: model.deviceCompatible !== false,
    }));

  if (!options.some((option) => option.value === "lama")) {
    options.push({
      label: "Lama去除模型",
      value: "lama",
      installed: true,
    });
  }

  if (!options.some((option) => option.value === "slbr")) {
    options.push({
      label: "透明水印去除模型 SLBR",
      value: "slbr",
      installed: false,
    });
  }

  if (!options.some((option) => option.value === "mat")) {
    options.push({
      label: "MAT 去除模型",
      value: "mat",
      installed: false,
      available: false,
      deviceCompatible: false,
    });
  }

  return options;
});
const getModelParameterSchema = (metadata = currentModelMetadata.value) => {
  const parameters = metadata?.parameters || {};
  return Object.fromEntries(
    Object.entries(parameters).filter(
      ([key, value]) => key !== "recommended" && value && typeof value === "object"
    )
  );
};
const ensureModelParameterDefaults = (metadata = currentModelMetadata.value) => {
  const schema = getModelParameterSchema(metadata);
  const nextValues = { ...(modelParameterValues.value || {}) };
  Object.entries(schema).forEach(([key, field]) => {
    if (nextValues[key] === undefined) {
      nextValues[key] = field.default ?? "";
    }
  });
  modelParameterValues.value = nextValues;
};
const updateModelParameter = (key, value) => {
  modelParameterValues.value = {
    ...modelParameterValues.value,
    [key]: value,
  };
};
const applyRecommendedModelParameters = (recommended = {}) => {
  modelParameterValues.value = {
    ...modelParameterValues.value,
    ...(recommended || {}),
  };
};
const getCurrentModelOptionsPayload = () => {
  const schema = getModelParameterSchema();
  return Object.fromEntries(
    Object.entries(schema).map(([key, field]) => [
      key,
      modelParameterValues.value[key] ?? field.default ?? "",
    ])
  );
};
const loadVideoModelOptions = async ({ preferredModel = currentModel.value } = {}) => {
  await modelRegistryStore.loadModels();
  const availableVideoModels = videoModelOptions.value;
  const isOptionAvailable = (option) => option?.available !== false;
  const selectableModels = availableVideoModels.filter(isOptionAvailable);
  const sharedModel = String(appStateStore.getSharedCurrentModel?.() || "").trim();
  const hasPreferredModel = selectableModels.some((option) => option.value === preferredModel);
  const hasCurrentModel = selectableModels.some((option) => option.value === currentModel.value);
  const hasSharedModel = selectableModels.some((option) => option.value === sharedModel);
  const hasLamaModel = selectableModels.some((option) => option.value === "lama");
  let nextModel = currentModel.value || "lama";
  if (hasPreferredModel) {
    nextModel = preferredModel;
  } else if (!hasCurrentModel) {
    nextModel = hasSharedModel
      ? sharedModel
      : hasLamaModel
        ? "lama"
        : selectableModels[0]?.value || "lama";
  }
  const previousModel = currentModel.value;
  currentModel.value = nextModel;
  appStateStore.setSharedCurrentModel?.(nextModel);
  if (previousModel === "mat" && nextModel !== "mat") {
    $q.notify({ type: "warning", message: MAT_CUDA_FALLBACK_MESSAGE, position: "top" });
  }
  ensureModelParameterDefaults();
};
const handleModelChange = (model) => {
  if (!model || model === currentModel.value) return;
  const option = videoModelOptions.value.find((item) => item.value === model);
  if (option && option.available === false) {
    const fallback = videoModelOptions.value.find((item) => item.value === "lama" && item.available !== false);
    if (model === "mat" && fallback) {
      currentModel.value = "lama";
      appStateStore.setSharedCurrentModel?.("lama");
      ensureModelParameterDefaults();
      $q.notify({ type: "warning", message: MAT_CUDA_FALLBACK_MESSAGE, position: "top" });
      syncTimelineRowsFromStore();
      return;
    }
  }
  currentModel.value = model;
  appStateStore.setSharedCurrentModel?.(model);
  ensureModelParameterDefaults();
  $q.notify({
    type: "info",
    message: `已切换到${option?.label || model}`,
    position: "top",
  });
  syncTimelineRowsFromStore();
};
const isMaskInpaintModel = (modelId = currentModel.value) => (
  MASK_INPAINT_MODEL_IDS.includes(String(modelId || "").trim().toLowerCase())
);
const ensureBackendVideoModel = async (modelId = currentModel.value) => {
  const requestedModel = String(modelId || "lama").trim().toLowerCase();
  if (!isMaskInpaintModel(requestedModel)) return true;

  try {
    const response = await modelRegistryStore.switchModel(requestedModel);
    const activeModel = String(response?.currentModel || requestedModel).trim().toLowerCase();
    if (activeModel !== requestedModel) {
      handleModelChange(activeModel);
      if (requestedModel === "mat") {
        $q.notify({ type: "warning", message: MAT_CUDA_FALLBACK_MESSAGE, position: "top" });
      }
    }
    return true;
  } catch (error) {
    if (requestedModel === "mat") {
      handleModelChange("lama");
      try {
        await modelRegistryStore.switchModel("lama");
      } catch (fallbackError) {
        console.warn("Failed to switch backend video model to lama after MAT fallback:", fallbackError);
      }
      $q.notify({
        type: "warning",
        message: error?.message || MAT_CUDA_FALLBACK_MESSAGE,
        position: "top",
      });
      return true;
    }
    $q.notify({
      type: "negative",
      message: error?.message || "视频模型切换失败",
      position: "top",
    });
    return false;
  }
};
const openModelManagement = (modelId = currentModel.value) => {
  globalSettings?.open?.({
    tab: "models",
    modelId: modelId || currentModel.value || "lama",
  });
};

const canRun = computed(
  () =>
    videoStore.hasVideoFile &&
    videoStore.videoWidth > 0 &&
    videoStore.videoHeight > 0 &&
    videoStore.videoDuration > 0 &&
    (!currentModelRequiresMask.value || videoStore.masks.length > 0) &&
    currentModelMetadata.value?.installed !== false &&
    !(currentModelMetadata.value?.corruptFiles?.length > 0)
);
const isVideoDrawingShortcutReady = computed(
  () =>
    Boolean(
        videoStore.hasVideoFile &&
        currentModelRequiresMask.value &&
        selectedMaskIsEditableStandard.value &&
        !isProcessing.value &&
        videoOverlayRef.value?.isReady?.()
      )
);

const getCurrentSamVideoFrameIndex = () => {
  const fps = Math.max(1, Number(videoStore.sourceFrameRate || sourceFps.value || 30));
  const maxFrameIndex = Math.max(0, Math.ceil(Number(videoStore.videoDuration || 0) * fps) - 1);
  return Math.min(maxFrameIndex, Math.max(0, Math.round(Number(videoStore.currentTime || 0) * fps)));
};

const getSamVideoSourcePath = () =>
  String(videoStore.currentSourcePath || videoStore.videoFile?.path || "").trim();

const checkLocalFileExists = async (filePath) => {
  const normalizedPath = String(filePath || "").trim();
  if (!normalizedPath) return false;
  if (!window.electron?.ipcRenderer?.invoke) {
    return true;
  }
  try {
    const result = await window.electron.ipcRenderer.invoke("get-file-stats", normalizedPath);
    return Boolean(result?.success);
  } catch (error) {
    console.warn("检查视频本地路径失败，将尝试临时缓存视频:", error);
    return false;
  }
};

const samVideoMissingLocalPathMessage =
  "当前视频没有后端可读取的本地文件路径。请通过“选择视频文件”重新导入本地视频，避免使用仅浏览器临时可见的 blob/会话文件后再运行 SAM 智能选区。";

const isSamVideoPromptSupportedByActiveModel = (prompt = {}) => {
  if (prompt.box) return activeSamVideoSupportsBox.value;
  if (Array.isArray(prompt.points) && prompt.points.length > 0) {
    return activeSamVideoSupportsPoint.value;
  }
  return false;
};
const selectedSamVideoHasUnsupportedPrompt = computed(() =>
  selectedSamVideoPromptObjects.value.some((item) => !isSamVideoPromptSupportedByActiveModel(item))
);

const canRunSamVideoPropagation = computed(
  () =>
    videoStore.hasVideoFile &&
    Boolean(videoStore.videoFile) &&
    selectedMaskIsSamVideo.value &&
    activeSamVideoSupportsPropagate.value &&
    (activeSamVideoSupportsPoint.value || activeSamVideoSupportsBox.value) &&
    !isProcessing.value &&
    !samVideoState.running &&
    selectedSamVideoPromptObjects.value.length > 0 &&
    !selectedSamVideoHasUnsupportedPrompt.value
);

const samVideoSelectionActionTooltip = computed(() => {
  if (!videoStore.hasVideoFile) return "请先打开视频文件";
  if (isProcessing.value) return "视频处理中暂不能创建智能选区轨道";
  if (samVideoState.running) return "SAM 视频传播正在运行";
  return "新建一条空的 SAM 智能选区轨道";
});

const canRunSamVideoSelectionFromMaskList = computed(
  () => videoStore.hasVideoFile && !isProcessing.value && !samVideoState.running
);

const summarizeSamVideoResult = (result = {}) => {
  const frames = Array.isArray(result.frames) ? result.frames : [];
  const maskCount = frames.reduce(
    (total, frame) => total + (Array.isArray(frame.masks) ? frame.masks.length : 0),
    0
  );
  return {
    frameCount: frames.length,
    maskCount,
    objectCount: Array.isArray(result.objects) ? result.objects.length : 0,
    persistedCount: Number(result.assets?.samVideoMasks?.persistedCount || 0),
    skippedCount: Number(result.assets?.samVideoMasks?.skippedCount || 0),
    modelId: result.modelId || "",
  };
};

const runSamVideoSelectionFromMaskList = async () => {
  if (!canRunSamVideoSelectionFromMaskList.value) return null;
  const track = videoStore.createEmptySamVideoMaskTrack();
  syncTimelineRowsFromStore();
  samVideoState.message = "已创建空智能选区轨道。请在预览画面点选/框选对象后运行智能选区。";
  samVideoState.error = "";
  return track;
};

const getNextSamVideoObjectId = () => {
  const ids = new Set([
    ...selectedSamVideoPromptObjects.value.map((item) => Number(item.objectId)),
    ...selectedSamVideoResultObjects.value.map((item) => Number(item.objectId)),
  ]);
  let nextId = 1;
  while (ids.has(nextId)) nextId += 1;
  return nextId;
};

const addSamVideoPromptToSelectedTrack = ({ point = null, box = null } = {}) => {
  if (!selectedMaskIsSamVideo.value || !videoStore.selectedMaskId) {
    $q.notify({ type: "warning", message: "请先创建并选中智能选区轨道", timeout: 2500 });
    return null;
  }
  if (point && !activeSamVideoSupportsPoint.value) {
    $q.notify({
      type: "warning",
      message: "当前 SAM 视频模型不支持点选新建对象，请改用框选或文本智选。",
      timeout: 3000,
    });
    return null;
  }
  if (box && !activeSamVideoSupportsBox.value) {
    $q.notify({
      type: "warning",
      message: "当前 SAM 视频模型不支持框选对象，请切换模型或使用文本智选。",
      timeout: 3000,
    });
    return null;
  }
  const prompt = {
    objectId: getNextSamVideoObjectId(),
    frameIndex: getCurrentSamVideoFrameIndex(),
    ...(box ? { box } : { points: [{ ...point, label: 1 }] }),
  };
  const track = videoStore.addSamVideoPromptObject(videoStore.selectedMaskId, prompt);
  samVideoState.message = box
    ? `已添加对象 ${prompt.objectId} 的框选提示`
    : `已添加对象 ${prompt.objectId} 的点选提示`;
  samVideoState.error = "";
  return track;
};

const handleSamVideoPromptFromOverlay = (payload = {}) => {
  addSamVideoPromptToSelectedTrack(payload);
};

const collectSamVideoMaskAssetPaths = (mask, { objectId = null } = {}) => {
  const targetObjectId = objectId == null ? null : Number(objectId);
  return [
    ...new Set(
      (mask?.samFrames || mask?.frames || [])
        .flatMap((frame) => frame.masks || [])
        .filter((item) => targetObjectId == null || Number(item.objectId) === targetObjectId)
        .map((item) => String(item.maskPath || "").trim())
        .filter(Boolean)
    ),
  ];
};

const cleanupSamVideoMaskAssetPaths = async (paths = []) => {
  if (!paths.length || !window.electron?.ipcRenderer?.invoke) return;
  await Promise.allSettled(
    paths.map((filePath) => window.electron.ipcRenderer.invoke("cleanup-temp-file", filePath))
  );
};

const removeSelectedSamVideoObject = async (objectId) => {
  if (!selectedMaskIsSamVideo.value || !videoStore.selectedMaskId) return null;
  const assetPaths = collectSamVideoMaskAssetPaths(videoStore.selectedMask, { objectId });
  const track = videoStore.removeSamVideoObject(videoStore.selectedMaskId, objectId);
  await cleanupSamVideoMaskAssetPaths(assetPaths);
  syncTimelineRowsFromStore();
  return track;
};

const setSelectedSamVideoObjectExpandPx = (objectId, value) => {
  if (!selectedMaskIsSamVideo.value || !videoStore.selectedMaskId) return null;
  return videoStore.setSamVideoObjectExpandPx(
    videoStore.selectedMaskId,
    objectId,
    normalizeSamVideoExpandPx(value)
  );
};

const removeVideoMaskTrack = async (maskId) => {
  const mask = videoStore.masks.find((item) => item.id === maskId);
  if (!mask) return null;
  const assetPaths = mask.type === "samVideo" ? collectSamVideoMaskAssetPaths(mask) : [];
  const removed = videoStore.removeMask(maskId);
  await cleanupSamVideoMaskAssetPaths(assetPaths);
  syncTimelineRowsFromStore();
  return removed;
};

const clearSelectedSamVideoResult = async () => {
  if (!selectedMaskIsSamVideo.value || !videoStore.selectedMaskId) return null;
  const assetPaths = collectSamVideoMaskAssetPaths(videoStore.selectedMask);
  const track = videoStore.clearSamVideoResult(videoStore.selectedMaskId);
  await cleanupSamVideoMaskAssetPaths(assetPaths);
  samVideoState.lastResultSummary = null;
  samVideoState.lastTrackId = "";
  samVideoState.progress = 0;
  samVideoState.error = "";
  samVideoState.message = track
    ? "已清空当前智能选区轨道，请重新点选/框选对象后运行。"
    : "未找到可清空的智能选区轨道。";
  samVideoCandidateMenuOpen.value = false;
  syncTimelineRowsFromStore();
  return track;
};

const mergeSamVideoPropagationResults = ({ forward = {}, backward = {}, promptObjects = [], frameIndex = 0 } = {}) => {
  const frameMap = new Map();
  [backward, forward].forEach((result) => {
    (result?.frames || []).forEach((frame) => {
      const normalizedFrameIndex = Number(frame.frameIndex ?? frame.frame_index ?? 0);
      const existing = frameMap.get(normalizedFrameIndex) || { frameIndex: normalizedFrameIndex, masks: [] };
      const objectMap = new Map(existing.masks.map((item) => [Number(item.objectId), item]));
      (frame.masks || []).forEach((item) => {
        const objectId = Number(item.objectId ?? item.object_id ?? 0);
        const maskPath = typeof item.maskPath === "string" ? item.maskPath : "";
        const maskSignature = typeof item.maskSignature === "string" ? item.maskSignature : "";
        if (objectId > 0 && maskPath) {
          objectMap.set(objectId, {
            objectId,
            maskPath,
            maskAssetId: item.maskAssetId || "",
            maskSignature,
            maskSize: Number(item.maskSize || 0),
          });
        }
      });
      frameMap.set(normalizedFrameIndex, {
        frameIndex: normalizedFrameIndex,
        masks: [...objectMap.values()].sort((a, b) => a.objectId - b.objectId),
      });
    });
  });

  const objectMap = new Map();
  [...(backward.objects || []), ...(forward.objects || [])].forEach((item) => {
    const objectId = Number(item.objectId ?? item.object_id ?? 0);
    if (objectId > 0) objectMap.set(objectId, { ...item, objectId });
  });

  return {
    ...forward,
    modelId: forward.modelId || backward.modelId || defaultSamVideoModelId.value,
    frameCount: Math.max(Number(forward.frameCount || 0), Number(backward.frameCount || 0)),
    width: forward.width || backward.width,
    height: forward.height || backward.height,
    objectCount: objectMap.size || promptObjects.length,
    objects: [...objectMap.values()].sort((a, b) => Number(a.objectId) - Number(b.objectId)),
    promptObjects: promptObjects.map((item) => ({ ...item })),
    frames: [...frameMap.values()]
      .filter((frame) => frame.masks.length > 0)
      .sort((a, b) => a.frameIndex - b.frameIndex),
    input: {
      ...(forward.input || backward.input || {}),
      frameIndex,
      propagation: "bidirectional",
      forwardFrameCount: Array.isArray(forward.frames) ? forward.frames.length : 0,
      backwardFrameCount: Array.isArray(backward.frames) ? backward.frames.length : 0,
    },
  };
};

const buildSamVideoMaskAssetRoot = async ({ sourcePath = "", trackId = "", runId = "" } = {}) => {
  if (!window.electron?.ipcRenderer?.invoke || !window.electron?.ipcRenderer?.joinPath) {
    return "";
  }
  const tempBase = resolveConfiguredTempBase(sourcePath || getSamVideoSourcePath() || "");
  const safeTrackId = String(trackId || "track").replace(/[^a-zA-Z0-9_-]/g, "_");
  const safeRunId = String(runId || Date.now()).replace(/[^a-zA-Z0-9_-]/g, "_");
  const root = window.electron.ipcRenderer.joinPath(
    tempBase,
    SAM_VIDEO_MASK_ASSET_DIRECTORY,
    safeTrackId,
    safeRunId
  );
  await window.electron.ipcRenderer.invoke("ensure-directory", root);
  return root;
};

const persistSamVideoMaskAssets = async ({
  result = {},
  trackId = "",
  sourcePath = "",
  assetRoot: providedAssetRoot = "",
  onProgress = null,
} = {}) => {
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  if (!frames.length || !window.electron?.ipcRenderer?.invoke) {
    return result;
  }

  const runId = `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
  let assetRoot = providedAssetRoot || "";
  if (!assetRoot) {
    try {
      assetRoot = await buildSamVideoMaskAssetRoot({ sourcePath, trackId, runId });
    } catch (error) {
      throw new Error(`创建 SAM 视频蒙版资产目录失败：${error.message}`);
    }
    if (!assetRoot) {
      throw new Error("创建 SAM 视频蒙版资产目录失败：未返回有效目录。");
    }
  }

  let pathBackedCount = 0;
  let skippedCount = 0;
  const persistedFrames = [];
  const totalFrames = frames.length;
  onProgress?.({ current: 0, total: totalFrames });
  for (const [frameOffset, frame] of frames.entries()) {
    const frameIndex = Math.max(0, Math.floor(Number(frame.frameIndex ?? frame.frame_index ?? 0)));
    const persistedMasks = [];
    for (const item of frame.masks || []) {
      const objectId = Math.max(
        1,
        Math.floor(Number((item.objectId ?? item.object_id ?? item.id) || 1))
      );
      const maskPath = String(item.maskPath || "").trim();
      if (!maskPath) {
        skippedCount += 1;
        continue;
      }
      pathBackedCount += 1;
      persistedMasks.push({
        objectId,
        maskPath,
        maskAssetId: item.maskAssetId || `${runId}:${frameIndex}:${objectId}`,
        maskSize: Number(item.maskSize || 0),
        maskSignature: item.maskSignature || "",
      });
    }

    if (persistedMasks.length > 0) {
      persistedFrames.push({
        ...frame,
        frameIndex,
        masks: persistedMasks,
      });
    }
    onProgress?.({ current: frameOffset + 1, total: totalFrames });
  }

  return {
    ...result,
    frames: persistedFrames,
    assets: {
      ...(result.assets || {}),
      samVideoMasks: {
        type: "local-files",
        root: assetRoot,
        runId,
        persistedCount: pathBackedCount,
        skippedCount,
      },
    },
  };
};

const resolveSamVideoMaskAutoExpandPxFromPath = async (maskPath = "", width = 0, height = 0) => {
  if (!maskPath) return 0;
  try {
    const image = await loadImageElement(getLocalFileUrl(maskPath));
    const canvas =
      typeof OffscreenCanvas !== "undefined"
        ? new OffscreenCanvas(width || image.width || 1, height || image.height || 1)
        : document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(width || image.width || 1));
    canvas.height = Math.max(1, Math.floor(height || image.height || 1));
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const data = imageData.data;
    for (let index = 0; index < data.length; index += 4) {
      const luminance = Math.max(data[index], data[index + 1], data[index + 2]);
      const alpha = data[index + 3];
      data[index + 3] = alpha < 255 ? (alpha > 0 ? 255 : 0) : (luminance > 127 ? 255 : 0);
    }
    const maskInfo = inspectSamMaskPixels(imageData);
    if (!maskInfo) return 0;
    return normalizeSamExpandRadius(
      resolveSamAutoExpandRadius({
        bboxWidth: maskInfo.bboxWidth,
        bboxHeight: maskInfo.bboxHeight,
        imageWidth: canvas.width,
        imageHeight: canvas.height,
      })
    );
  } catch (error) {
    console.warn("计算 SAM 视频对象自动扩边失败，已使用 0px:", error);
    return 0;
  }
};

const hydrateSamVideoObjectExpandDefaults = async (result = {}) => {
  const frames = Array.isArray(result?.frames) ? result.frames : [];
  if (!frames.length) return result;

  const width = Number(result.width || videoStore.videoWidth || 0);
  const height = Number(result.height || videoStore.videoHeight || 0);
  const radiusMap = new Map();
  for (const frame of frames) {
    for (const item of frame.masks || []) {
      const objectId = Number(item.objectId ?? item.object_id ?? 0);
      const maskPath = String(item.maskPath || "").trim();
      if (objectId <= 0 || !maskPath) continue;
      const radius = await resolveSamVideoMaskAutoExpandPxFromPath(maskPath, width, height);
      radiusMap.set(objectId, Math.max(radiusMap.get(objectId) || 0, radius));
    }
  }

  if (!radiusMap.size) return result;
  const objectMap = new Map(
    (result.objects || []).map((item) => [
      Number(item.objectId ?? item.object_id ?? item.id ?? 0),
      { ...item },
    ])
  );
  radiusMap.forEach((radius, objectId) => {
    const existing = objectMap.get(objectId) || { objectId };
    const autoExpandPx = normalizeSamVideoExpandPx(existing.autoExpandPx, radius);
    const hasManualValue = existing.expandPx != null;
    objectMap.set(objectId, {
      ...existing,
      objectId,
      autoExpandPx,
      expandPx: normalizeSamVideoExpandPx(hasManualValue ? existing.expandPx : autoExpandPx, autoExpandPx),
    });
  });

  return {
    ...result,
    objects: [...objectMap.values()].sort(
      (left, right) => Number(left.objectId) - Number(right.objectId)
    ),
  };
};

const ensureSamVideoSourcePath = async () => {
  const existingPath = getSamVideoSourcePath();
  if (existingPath) {
    if (await checkLocalFileExists(existingPath)) {
      return existingPath;
    }
    samVideoState.message = "原视频路径已失效，正在缓存当前视频到本地临时文件";
    videoStore.setCurrentSourceMeta({
      sourcePath: "",
      sourceName: videoStore.currentSourceName || videoStore.videoFile?.name || "",
    });
  }

  if (!videoStore.videoFile) {
    throw new Error("请先导入视频");
  }

  const sourceInfo = await resolveVideoSourcePath(videoStore.videoFile, {
    preferExistingPath: !existingPath,
  });
  const sourcePath = sourceInfo?.sourcePath || "";
  if (!sourcePath) {
    throw new Error(samVideoMissingLocalPathMessage);
  }

  videoStore.setCurrentSourceMeta({
    sourcePath,
    sourceName: videoStore.currentSourceName || videoStore.videoFile.name || "",
  });
  return sourcePath;
};

const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

const getSamVideoJobStageText = (job = {}, directionLabel = "") => {
  const phase = String(job.phase || job.status || "");
  const current = Number(job.current || 0);
  const total = Number(job.total || 0);
  const countText = total > 0 ? ` ${current}/${total}` : "";
  const prefix = directionLabel ? `${directionLabel} · ` : "";
  if (phase === "staging_frames") return `${prefix}抽取视频帧${countText}`;
  if (phase === "frame_loading") return `${prefix}加载视频帧${countText}`;
  if (phase === "prompt_encoding") return `${prefix}注册对象提示${countText}`;
  if (phase === "propagating") return `${prefix}传播蒙版${countText}`;
  if (phase === "writing_masks") return `${prefix}写入蒙版${countText}`;
  if (phase === "completed") return `${prefix}传播完成`;
  if (phase === "failed") return `${prefix}传播失败`;
  if (phase === "canceled") return `${prefix}传播已取消`;
  return `${prefix}${job.message || "等待 SAM 视频传播"}`;
};

const applySamVideoJobProgress = (job = {}, directionLabel = "") => {
  const progress = Math.max(0, Math.min(1, Number(job.progress || 0)));
  samVideoState.progress = progress;
  samVideoState.message = getSamVideoJobStageText(job, directionLabel);
  updateSamVideoGlobalLoadingOverlay(samVideoState.message, progress);
};

const runSamVideoPropagationJob = async (request, directionLabel) => {
  const createResponse = await createSamVideoPropagationJob(request);
  let job = createResponse?.data || createResponse;
  const taskId = job?.taskId || job?.task_id;
  if (!taskId) {
    throw new Error("SAM 视频传播任务没有返回有效 taskId");
  }
  applySamVideoJobProgress(job, directionLabel);

  while (!["completed", "failed", "canceled"].includes(String(job.status || ""))) {
    await sleep(700);
    const statusResponse = await getSamVideoPropagationJob(taskId);
    job = statusResponse?.data || statusResponse;
    applySamVideoJobProgress(job, directionLabel);
  }

  if (job.status === "failed") {
    throw new Error(job.error || job.message || "SAM 视频传播任务失败");
  }
  if (job.status === "canceled") {
    throw new Error(job.message || "SAM 视频传播任务已取消");
  }

  const resultResponse = await getSamVideoPropagationJobResult(taskId);
  return resultResponse?.data || resultResponse;
};

const resolveSamCpuRiskDialog = (confirmed) => {
  const resolver = samCpuRiskDialogResolve;
  samCpuRiskDialogResolve = null;
  samCpuRiskDialogOpen.value = false;
  resolver?.(Boolean(confirmed && samCpuRiskAcknowledged.value));
};

const requestSamVideoCpuRiskConfirmation = async (modelId) => {
  const normalizedModelId = String(modelId || "").trim();
  const modelOption =
    samVideoModelOptions.value.find((option) => option.value === normalizedModelId) ||
    activeSamVideoModelOption.value;
  const family =
    modelOption?.family ||
    (["sam3", "sam3_1_multiplex"].includes(normalizedModelId) ? "sam3" : "");
  if (family !== "sam3" || samVideoRuntimeDevice.value === "cuda") {
    return true;
  }
  if (samCpuRiskDialogOpen.value) {
    return false;
  }
  samCpuRiskAcknowledged.value = false;
  samCpuRiskDialogOpen.value = true;
  return new Promise((resolve) => {
    samCpuRiskDialogResolve = resolve;
  });
};

const filterSamVideoTextNounOptions = (value, update) => {
  update(() => {
    const keyword = String(value || "").trim().toLowerCase();
    const nouns = samVideoTextLexicon.value.nouns || [];
    samVideoTextFilteredNouns.value = keyword
      ? nouns.filter((entry) =>
          [entry.zh, entry.en, entry.category]
            .filter(Boolean)
            .some((item) => String(item).toLowerCase().includes(keyword))
        )
      : nouns;
  });
};

const refreshSamVideoTextLexicon = async () => {
  try {
    const lexicon = await loadSam3Lexicon();
    samVideoTextLexicon.value = lexicon;
    samVideoTextFilteredNouns.value = lexicon.nouns || [];
  } catch (error) {
    samVideoTextLexicon.value = { colors: [], nouns: [] };
    samVideoTextFilteredNouns.value = [];
    console.warn("Failed to load SAM3 video lexicon:", error);
  }
};

const runSamVideoPropagation = async () => {
  const targetMaskId = videoStore.selectedMaskId;
  const promptObjects = selectedSamVideoPromptObjects.value.map((item) => ({ ...item }));
  const previousAssetPaths = collectSamVideoMaskAssetPaths(videoStore.selectedMask);
  const modelId = activeSamVideoModelId.value;
  if (!canRunSamVideoPropagation.value) {
    samVideoState.message = !videoStore.hasVideoFile
      ? "请先导入视频"
      : !selectedMaskIsSamVideo.value
      ? "请先选择智能选区轨道"
      : selectedSamVideoHasUnsupportedPrompt.value
      ? "当前 SAM 视频模型不支持待选对象中的点选/框选类型"
      : promptObjects.length === 0
      ? "请先在预览画面点选或框选至少一个对象"
      : "当前无法运行 SAM 视频智能选区";
    samVideoState.error = samVideoState.message;
    return null;
  }

  if (!(await requestSamVideoCpuRiskConfirmation(modelId))) {
    samVideoState.message = "已取消 SAM 视频智能选区。";
    return null;
  }

  samVideoState.running = true;
  samVideoState.progress = 0;
  samVideoState.error = "";
  samVideoState.message = "正在准备 SAM 视频传播";
  samVideoState.lastResultSummary = null;
  samVideoState.lastTrackId = "";
  updateSamVideoGlobalLoadingOverlay("准备阶段：正在启动 SAM 视频智能选区任务", samVideoState.progress);

  try {
    const sourcePath = await ensureSamVideoSourcePath();
    const assetRoot = await buildSamVideoMaskAssetRoot({
      sourcePath,
      trackId: targetMaskId,
      runId: `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    });
    const forwardMaskOutputDir = window.electron.ipcRenderer.joinPath(assetRoot, "forward");
    const backwardMaskOutputDir = window.electron.ipcRenderer.joinPath(assetRoot, "backward");
    await window.electron.ipcRenderer.invoke("ensure-directory", forwardMaskOutputDir);
    await window.electron.ipcRenderer.invoke("ensure-directory", backwardMaskOutputDir);
    const frameIndex = Number.isInteger(videoStore.selectedMask?.samPromptFrameIndex)
      ? videoStore.selectedMask.samPromptFrameIndex
      : promptObjects[0]?.frameIndex ?? getCurrentSamVideoFrameIndex();
    const commonRequest = {
      inputType: "videoPath",
      videoPath: sourcePath,
      modelId,
      frameIndex,
      maxFrames: null,
      objects: promptObjects.map((item) => ({
        objectId: item.objectId,
        points: item.points,
        box: item.box,
      })),
      responseType: "path",
    };
    const forwardResponse = await runSamVideoPropagationJob({
      ...commonRequest,
      reverse: false,
      maskOutputDir: forwardMaskOutputDir,
    }, "正向传播");
    const backwardResponse = await runSamVideoPropagationJob({
      ...commonRequest,
      reverse: true,
      maskOutputDir: backwardMaskOutputDir,
    }, "反向传播");
    const normalizePathMaskFrame = (result = {}, side = "") => ({
      ...result,
      frames: (result.frames || []).map((frame) => ({
        ...frame,
        masks: (frame.masks || []).map((item) => ({
          objectId: item.objectId,
          maskPath: item.maskPath || "",
          maskAssetId: item.maskAssetId || "",
          maskSignature: item.maskSignature || "",
          maskSize: Number(item.maskSize || 0),
          side,
        })),
      })),
    });
    const mergedResult = mergeSamVideoPropagationResults({
      forward: normalizePathMaskFrame(forwardResponse, "forward"),
      backward: normalizePathMaskFrame(backwardResponse, "backward"),
      promptObjects,
      frameIndex,
    });
    let result = await persistSamVideoMaskAssets({
      result: mergedResult,
      trackId: targetMaskId,
      sourcePath,
      assetRoot,
      onProgress: ({ current, total }) => {
        const progress = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
        samVideoState.progress = progress;
        const countText = total > 0 ? ` ${current}/${total}` : "";
        samVideoState.message = `缓存阶段 · 写入本地蒙版资产${countText}`;
        updateSamVideoGlobalLoadingOverlay(samVideoState.message, progress);
      },
    });
    result = await hydrateSamVideoObjectExpandDefaults(result);
    samVideoState.lastResultSummary = summarizeSamVideoResult(result);
    samVideoState.progress = 1;
    updateSamVideoGlobalLoadingOverlay("完成阶段：正在写入智能选区轨道", 1);
    const updateResult = videoStore.updateSamVideoMaskTrackResult(targetMaskId, result);
    const track = updateResult.mask || null;
    if (track) {
      await cleanupSamVideoMaskAssetPaths(previousAssetPaths);
      syncTimelineRowsFromStore();
    } else {
      await cleanupSamVideoMaskAssetPaths(collectSamVideoMaskAssetPaths(result));
    }
    samVideoState.lastTrackId = track?.id || "";
    samVideoState.message = track
      ? `SAM 已更新 ${track.name}，共 ${result?.frames?.length || 0} 帧`
      : updateResult.error || `SAM 已返回 ${result?.frames?.length || 0} 帧，但没有可用蒙版`;
    return result;
  } catch (error) {
    samVideoState.progress = 0;
    samVideoState.error = error?.message || String(error);
    samVideoState.message = samVideoState.error;
    $q.notify({
      type: "negative",
      message: samVideoState.error,
      timeout: 5000,
    });
    return null;
  } finally {
    samVideoState.running = false;
    hideGlobalLoadingOverlay();
  }
};

const runSamVideoTextPropagation = async () => {
  const modelId = activeSamVideoModelId.value;
  const promptSpec = samVideoTextPromptSpec.value;
  if (!canRunSamVideoTextPropagation.value) {
    samVideoState.message = !videoStore.hasVideoFile
      ? "请先导入视频"
      : !activeSamVideoSupportsText.value
      ? "当前 SAM 视频模型不支持文本智选"
      : !promptSpec.text
      ? "请输入文本提示或选择颜色/目标"
      : "当前无法运行 SAM 文本视频智选";
    samVideoState.error = samVideoState.message;
    return null;
  }

  if (!(await requestSamVideoCpuRiskConfirmation(modelId))) {
    samVideoState.message = "已取消 SAM 文本视频智选。";
    return null;
  }

  const targetTrack = videoStore.createEmptySamVideoMaskTrack();
  syncTimelineRowsFromStore();
  const targetMaskId = targetTrack?.id || videoStore.selectedMaskId;
  if (!targetMaskId) {
    samVideoState.error = "创建 SAM 视频轨道失败。";
    samVideoState.message = samVideoState.error;
    return null;
  }

  samVideoState.running = true;
  samVideoState.progress = 0;
  samVideoState.error = "";
  samVideoState.message = "正在准备 SAM 文本视频智选";
  samVideoState.lastResultSummary = null;
  samVideoState.lastTrackId = "";
  updateSamVideoGlobalLoadingOverlay("准备阶段：正在启动 SAM 文本视频智选任务", samVideoState.progress);

  try {
    const sourcePath = await ensureSamVideoSourcePath();
    const assetRoot = await buildSamVideoMaskAssetRoot({
      sourcePath,
      trackId: targetMaskId,
      runId: `run_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`,
    });
    const forwardMaskOutputDir = window.electron.ipcRenderer.joinPath(assetRoot, "forward");
    const backwardMaskOutputDir = window.electron.ipcRenderer.joinPath(assetRoot, "backward");
    await window.electron.ipcRenderer.invoke("ensure-directory", forwardMaskOutputDir);
    await window.electron.ipcRenderer.invoke("ensure-directory", backwardMaskOutputDir);

    const frameIndex = getCurrentSamVideoFrameIndex();
    const commonRequest = {
      inputType: "videoPath",
      videoPath: sourcePath,
      modelId,
      frameIndex,
      maxFrames: null,
      text: promptSpec.text,
      language: promptSpec.language || "auto",
      promptSource: promptSpec.source || "manual",
      promptColor: promptSpec.color || null,
      promptNoun: promptSpec.noun || null,
      responseType: "path",
    };
    const forwardResponse = await runSamVideoPropagationJob({
      ...commonRequest,
      reverse: false,
      maskOutputDir: forwardMaskOutputDir,
    }, "正向传播");
    const backwardResponse = await runSamVideoPropagationJob({
      ...commonRequest,
      reverse: true,
      maskOutputDir: backwardMaskOutputDir,
    }, "反向传播");
    const normalizePathMaskFrame = (result = {}, side = "") => ({
      ...result,
      frames: (result.frames || []).map((frame) => ({
        ...frame,
        masks: (frame.masks || []).map((item) => ({
          objectId: item.objectId,
          maskPath: item.maskPath || "",
          maskAssetId: item.maskAssetId || "",
          maskSignature: item.maskSignature || "",
          maskSize: Number(item.maskSize || 0),
          side,
        })),
      })),
    });
    const mergedResult = mergeSamVideoPropagationResults({
      forward: normalizePathMaskFrame(forwardResponse, "forward"),
      backward: normalizePathMaskFrame(backwardResponse, "backward"),
      promptObjects: [],
      frameIndex,
    });
    let result = await persistSamVideoMaskAssets({
      result: mergedResult,
      trackId: targetMaskId,
      sourcePath,
      assetRoot,
      onProgress: ({ current, total }) => {
        const progress = total > 0 ? Math.max(0, Math.min(1, current / total)) : 0;
        samVideoState.progress = progress;
        const countText = total > 0 ? ` ${current}/${total}` : "";
        samVideoState.message = `缓存阶段 · 写入本地蒙版资产${countText}`;
        updateSamVideoGlobalLoadingOverlay(samVideoState.message, progress);
      },
    });
    result = await hydrateSamVideoObjectExpandDefaults(result);
    samVideoState.lastResultSummary = summarizeSamVideoResult(result);
    samVideoState.progress = 1;
    updateSamVideoGlobalLoadingOverlay("完成阶段：正在写入智能选区轨道", 1);
    const updateResult = videoStore.updateSamVideoMaskTrackResult(targetMaskId, result);
    const track = updateResult.mask || null;
    if (!track) {
      videoStore.removeMask(targetMaskId);
      syncTimelineRowsFromStore();
      const emptyReason =
        result?.diagnostics?.emptyResultReason ||
        forwardResponse?.diagnostics?.emptyResultReason ||
        backwardResponse?.diagnostics?.emptyResultReason ||
        updateResult.error ||
        "SAM 文本视频智选未检测到目标。";
      samVideoState.error = emptyReason;
      samVideoState.message = emptyReason;
      await cleanupSamVideoMaskAssetPaths(collectSamVideoMaskAssetPaths(result));
      $q.notify({ type: "warning", message: emptyReason, timeout: 4500 });
      return result;
    }
    syncTimelineRowsFromStore();
    samVideoState.lastTrackId = track.id || "";
    samVideoState.message = `SAM 文本智选已生成 ${track.name}，共 ${result?.frames?.length || 0} 帧`;
    return result;
  } catch (error) {
    if (targetMaskId) {
      videoStore.removeMask(targetMaskId);
      syncTimelineRowsFromStore();
    }
    samVideoState.progress = 0;
    samVideoState.error = error?.message || String(error);
    samVideoState.message = samVideoState.error;
    $q.notify({
      type: "negative",
      message: samVideoState.error,
      timeout: 5000,
    });
    return null;
  } finally {
    samVideoState.running = false;
    hideGlobalLoadingOverlay();
  }
};

const canUndoVideoMaskShortcut = computed(
  () => Boolean(isVideoDrawingShortcutReady.value && videoStore.canUndoSelectedMaskDraw)
);

const setVideoToolMode = (mode) => {
  if (!isVideoDrawingShortcutReady.value) {
    return false;
  }

  videoStore.updateMaskTool({
    mode,
  });
  return true;
};

const restoreVideoShortcutSession = (session = {}) => {
  if (!isVideoDrawingShortcutReady.value) {
    return;
  }

  videoStore.updateMaskTool({
    drawingEnabled:
      session.videoDrawingEnabled ?? videoStore.maskTool.drawingEnabled,
    mode: session.videoToolMode ?? videoStore.maskTool.mode,
  });
};

const handleVideoShortcutPress = (actionId) => {
  switch (actionId) {
    case "drawingUndo":
      if (canUndoVideoMaskShortcut.value) {
        videoStore.undoSelectedMaskDraw();
      }
      break;
    case "drawingResetView":
      if (isFullscreenLamaViewportMode.value) {
        resetFullscreenViewport();
      } else if (isVideoDrawingShortcutReady.value) {
        videoStore.resetSelectedMaskTransformAtCurrentTime();
      }
      break;
    case "drawingToggle":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: !videoStore.maskTool.drawingEnabled,
        });
      }
      break;
    case "drawingBrush":
      setVideoToolMode(MASK_TOOL_MODES.DRAW);
      break;
    case "drawingRect":
      setVideoToolMode(MASK_TOOL_MODES.RECT);
      break;
    case "drawingErase":
      setVideoToolMode(MASK_TOOL_MODES.ERASE);
      break;
    default:
      break;
  }
};

const handleVideoShortcutHoldStart = (actionId) => {
  switch (actionId) {
    case "drawingHoldBrush":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: true,
          mode: MASK_TOOL_MODES.DRAW,
        });
      }
      break;
    case "drawingHoldRect":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: true,
          mode: MASK_TOOL_MODES.RECT,
        });
      }
      break;
    case "drawingHoldErase":
      if (isVideoDrawingShortcutReady.value) {
        videoStore.updateMaskTool({
          drawingEnabled: true,
          mode: MASK_TOOL_MODES.ERASE,
        });
      }
      break;
    default:
      break;
  }
};

const handleVideoShortcutHoldEnd = (actionId, session) => {
  switch (actionId) {
    case "drawingHoldBrush":
    case "drawingHoldRect":
    case "drawingHoldErase":
      restoreVideoShortcutSession(session);
      break;
    default:
      break;
  }
};

useConfiguredShortcuts({
  enabled: computed(() => true),
  shortcutConfig: computed(() => configStore.config.shortcuts),
  createSessionContext: () => ({
    videoToolMode: videoStore.maskTool.mode,
    videoDrawingEnabled: videoStore.maskTool.drawingEnabled,
  }),
  onPress: (actionId) => {
    handleVideoShortcutPress(actionId);
  },
  onHoldStart: (actionId) => {
    handleVideoShortcutHoldStart(actionId);
  },
  onHoldEnd: (actionId, session) => {
    handleVideoShortcutHoldEnd(actionId, session);
  },
});

const getMimeTypeForPath = (filePath) => {
  const normalized = String(filePath || "").toLowerCase();
  if (normalized.endsWith(".mp4")) return "video/mp4";
  if (normalized.endsWith(".webm")) return "video/webm";
  if (normalized.endsWith(".png")) return "image/png";
  if (normalized.endsWith(".webp")) return "image/webp";
  if (normalized.endsWith(".jpg") || normalized.endsWith(".jpeg")) return "image/jpeg";
  return "application/octet-stream";
};

const getLocalFileUrl = (filePath) => {
  const normalizedPath = String(filePath || "").replace(/\\/g, "/");
  if (!normalizedPath) {
    throw new Error("文件路径不能为空");
  }

  if (window.electron) {
    return `atom://${encodeURI(normalizedPath)}`;
  }

  return normalizedPath.startsWith("file://")
    ? normalizedPath
    : `file://${encodeURI(normalizedPath)}`;
};

const encodeMaskImageAsJpegBlob = async (imageSource, width, height) => {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width || imageSource?.width || 1));
  canvas.height = Math.max(1, Math.floor(height || imageSource?.height || 1));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(imageSource, 0, 0, canvas.width, canvas.height);
  const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const maskValue = data[index + 3] > 0 ? 255 : 0;
    data[index] = maskValue;
    data[index + 1] = maskValue;
    data[index + 2] = maskValue;
    data[index + 3] = 255;
  }
  ctx.putImageData(imageData, 0, 0);
  return canvasToBlob(canvas, {
    mimeType: "image/jpeg",
    quality: 0.92,
  });
};

const createBinaryAlphaMaskBitmap = async (
  image,
  width,
  height,
  { expandForLama = false, expandPx = null } = {}
) => {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(width || image?.width || 1));
  canvas.height = Math.max(1, Math.floor(height || image?.height || 1));
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.drawImage(image, 0, 0, canvas.width, canvas.height);
  let imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const data = imageData.data;
  for (let index = 0; index < data.length; index += 4) {
    const luminance = Math.max(data[index], data[index + 1], data[index + 2]);
    const alpha = data[index + 3];
    const maskValue = alpha < 255 ? (alpha > 0 ? 255 : 0) : (luminance > 127 ? 255 : 0);
    data[index] = 255;
    data[index + 1] = 255;
    data[index + 2] = 255;
    data[index + 3] = maskValue;
  }
  if (expandForLama) {
    imageData = expandSamMaskImageDataForLama(imageData, {
      imageWidth: canvas.width,
      imageHeight: canvas.height,
      radiusOverride: expandPx,
    }).imageData;
  }
  ctx.putImageData(imageData, 0, 0);
  if (typeof createImageBitmap === "function") {
    return await createImageBitmap(canvas);
  }
  return await loadImageElement(canvas.toDataURL("image/png"));
};

const readLocalFileResponseViaIpc = async (filePath) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    throw new Error("当前环境无法读取本地文件");
  }

  const result = await window.electron.ipcRenderer.invoke("read-file", filePath);
  if (!result?.success || !result.data?.buffer) {
    throw new Error(result?.error || `读取文件失败: ${filePath}`);
  }

  const bytes = new Uint8Array(result.data.buffer);
  return new Response(bytes, {
    status: 200,
    headers: {
      "Content-Type": result.data.type || getMimeTypeForPath(filePath),
      "Content-Length": String(bytes.byteLength),
    },
  });
};

const fetchLocalFileResponse = async (filePath) => {
  const localUrl = getLocalFileUrl(filePath);

  try {
    const response = await fetch(localUrl);
    if (!response.ok && response.status !== 0) {
      throw new Error(`读取文件失败: ${filePath}`);
    }
    return response;
  } catch (error) {
    const isRecoverableElectronFetchError =
      window.electron?.ipcRenderer?.invoke &&
      (
        /URL scheme .* is not supported/i.test(String(error?.message || "")) ||
        /Failed to fetch/i.test(String(error?.message || ""))
      );
    if (!isRecoverableElectronFetchError) {
      throw error;
    }

    console.warn("Falling back to IPC local file read:", error);
    return await readLocalFileResponseViaIpc(filePath);
  }
};

const readFileBytes = async (filePath) => {
  const response = await fetchLocalFileResponse(filePath);
  return new Uint8Array(await response.arrayBuffer());
};

const unwrapElement = (value) => {
  if (value?.$el instanceof HTMLElement) return value.$el;
  return value instanceof HTMLElement ? value : null;
};

const disconnectPreviewStageResizeObserver = () => {
  if (!previewStageResizeObserver) return;
  previewStageResizeObserver.disconnect();
  previewStageResizeObserver = null;
};

const cancelScheduledLayoutUpdate = () => {
  if (!pendingLayoutFrameId) return;
  window.cancelAnimationFrame(pendingLayoutFrameId);
  pendingLayoutFrameId = 0;
};

const updateTimelineViewportWidth = () => {
  const element = unwrapElement(timelineViewportRef.value);
  timelineViewportWidth.value = Math.max(0, element?.clientWidth || 0);
};

const updateLayoutMetrics = () => {
  adjustPlayerSize();
  updateTimelineViewportWidth();
};

const scheduleLayoutMetricsUpdate = () => {
  if (pendingLayoutFrameId) return;

  pendingLayoutFrameId = window.requestAnimationFrame(async () => {
    pendingLayoutFrameId = 0;
    await nextTick();
    updateLayoutMetrics();
    syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
  });
};

const getTimelineTotalWidth = () =>
  Math.max(
    timelineStartLeft,
    (Math.max(videoStore.videoDuration || 0, 0) / Math.max(timelineScale.value, 0.0001)) *
      timelineScaleWidth +
      timelineStartLeft
  );

const syncTimelineViewport = ({ center = false, ensureVisible = false } = {}) => {
  if (!videoStore.hasVideoFile) return;
  if (!timelineRef.value?.setTime) return;

  const time = Math.max(0, Math.min(videoStore.currentTime || 0, videoStore.videoDuration || 0));
  timelineRef.value.setTime(time);

  if (!timelineRef.value?.setScrollLeft || timelineViewportWidth.value <= 0) return;

  const cursorLeft =
    (time / Math.max(timelineScale.value, 0.0001)) * timelineScaleWidth + timelineStartLeft;
  const viewportWidth = timelineViewportWidth.value;
  const totalWidth = getTimelineTotalWidth();
  const maxScroll = Math.max(0, totalWidth - viewportWidth);
  const currentScroll = timelineScrollLeft.value;

  let targetScroll = currentScroll;
  if (time <= 0.0005) {
    targetScroll = 0;
  } else if (center) {
    targetScroll = cursorLeft - viewportWidth / 2;
  } else if (ensureVisible) {
    const leftBoundary = currentScroll + 40;
    const rightBoundary = currentScroll + viewportWidth - Math.min(180, viewportWidth * 0.35);

    if (cursorLeft < leftBoundary || cursorLeft > rightBoundary) {
      targetScroll = cursorLeft - viewportWidth / 2;
    } else {
      return;
    }
  } else {
    return;
  }

  targetScroll = Math.max(0, Math.min(maxScroll, targetScroll));
  timelineScrollLeft.value = targetScroll;
  timelineRef.value.setScrollLeft(targetScroll);
};

const setTimelineZoomPercent = (value) => {
  timelineZoomPercent.value = Math.max(0, Math.min(100, value));
};

const decreaseTimelineZoom = () => {
  if (timelineZoomDisabled.value) return;
  setTimelineZoomPercent(timelineZoomPercent.value - timelineZoomStep);
};

const increaseTimelineZoom = () => {
  if (timelineZoomDisabled.value) return;
  setTimelineZoomPercent(timelineZoomPercent.value + timelineZoomStep);
};

const formatTimelineDuration = (input) => {
  const totalSeconds = Math.max(Number(input || 0), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds - hours * 3600 - minutes * 60;
  const normalizedSeconds = Number(
    seconds.toFixed(seconds < 10 && hours === 0 && minutes === 0 ? 2 : 1)
  );
  const secondText = `${normalizedSeconds}s`;

  if (hours > 0) {
    return `${hours}h${minutes}m${secondText}`;
  }
  if (minutes > 0) {
    return `${minutes}m${secondText}`;
  }
  return secondText;
};

const normalizeVideoResourceTab = (value) => {
  if (value === "masks") return "runtime";
  if (value === "runtime" || value === "info") return value;
  return "info";
};

const normalizeVideoEditorSections = (value = {}) => ({
  brush: value.brush !== undefined ? Boolean(value.brush) : true,
  range: value.range !== undefined ? Boolean(value.range) : false,
  keyframes: value.keyframes !== undefined ? Boolean(value.keyframes) : true,
  processingRange:
    value.processingRange !== undefined ? Boolean(value.processingRange) : true,
});

const captureVideoUiState = () => ({
  exportFpsMode: exportFpsMode.value,
  timelineZoomPercent: timelineZoomPercent.value,
  timelineScrollLeft: timelineScrollLeft.value,
  previewTrialSeconds: previewTrialSeconds.value,
  currentModel: currentModel.value,
  modelParameterValues: JSON.parse(JSON.stringify(modelParameterValues.value || {})),
  resourceManageTab: normalizeVideoResourceTab(resourceManageTab.value),
  videoEditorSections: normalizeVideoEditorSections(videoEditorSections.value),
  playbackRate: Number(videoStore.playbackRate || 1),
  isMuted: Boolean(videoStore.isMuted),
});

const restoreVideoUiState = async (uiState = {}) => {
  const sharedModel = String(appStateStore.getSharedCurrentModel?.() || "").trim();
  const restoredModel = String(sharedModel || uiState.currentModel || "").trim();
  if (restoredModel) {
    currentModel.value = restoredModel;
    appStateStore.setSharedCurrentModel?.(restoredModel);
  }

  if (uiState.modelParameterValues && typeof uiState.modelParameterValues === "object") {
    modelParameterValues.value = {
      ...uiState.modelParameterValues,
    };
  }

  resourceManageTab.value = normalizeVideoResourceTab(
    uiState.resourceManageTab || uiState.activeTab || uiState.leftTab || "info"
  );
  videoEditorSections.value = normalizeVideoEditorSections(
    uiState.videoEditorSections || uiState.editorSections || {}
  );

  exportFpsMode.value = uiState.exportFpsMode || "source";
  timelineZoomPercent.value = Math.max(
    0,
    Math.min(100, Number(uiState.timelineZoomPercent || 0))
  );
  timelineScrollLeft.value = Math.max(0, Number(uiState.timelineScrollLeft || 0));

  const restoredPreviewTrialSeconds = Number(uiState.previewTrialSeconds);
  if (VIDEO_PREVIEW_TRIAL_DURATIONS.includes(restoredPreviewTrialSeconds)) {
    previewTrialSeconds.value = restoredPreviewTrialSeconds;
  }

  const restoredPlaybackRate = Number(uiState.playbackRate);
  if (Number.isFinite(restoredPlaybackRate) && restoredPlaybackRate > 0) {
    videoStore.setPlaybackRate(restoredPlaybackRate);
  }
  if (typeof uiState.isMuted === "boolean") {
    videoStore.setIsMuted(uiState.isMuted);
  }

  ensureModelParameterDefaults();
  currentProgress.value = Math.max(
    0,
    Math.min(Number(videoStore.currentTime || 0), Math.max(Number(videoStore.videoDuration || 0), 0))
  );

  await nextTick();
  if (timelineRef.value?.setTime) {
    timelineRef.value.setTime(videoStore.currentTime || 0);
  }
  if (timelineRef.value?.setScrollLeft && timelineScrollLeft.value > 0) {
    timelineRef.value.setScrollLeft(timelineScrollLeft.value);
  } else {
    syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
  }
};

const persistVideoUiStateToAppState = () => {
  appStateStore.saveUIState("video", captureVideoUiState());
};

const getConfiguredVideoHistoryLimit = () =>
  Math.max(1, Number(configStore.config.video?.historyLimit || 5));

const confirmHistoryTrim = () =>
  new Promise((resolve) => {
    $q.dialog({
      title: "历史记录已满",
      message: "继续替换会删除最早的一条视频历史记录，是否继续？",
      ok: {
        label: "继续",
        color: "primary",
        unelevated: true,
      },
      cancel: {
        label: "取消",
        flat: true,
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });

const ensureFileExists = async (filePath) => checkLocalFileExists(filePath);

const getFailureSnapshotHint = (failureSnapshotDir) =>
  typeof failureSnapshotDir === "string" && failureSnapshotDir.trim()
    ? `\n失败快照: ${failureSnapshotDir.trim()}`
    : "";

const getMissingFilePaths = async (filePaths = []) => {
  const checks = await Promise.all(
    filePaths
      .filter(Boolean)
      .map(async (filePath) => ({
        filePath,
        exists: await ensureFileExists(filePath),
      }))
  );

  return checks.filter((item) => !item.exists).map((item) => item.filePath);
};

const validateVideoBatchResponse = async ({ batch, responseData }) => {
  const results = Array.isArray(responseData?.results) ? responseData.results : [];
  const failedResults = results.filter((item) => item?.success === false);
  const failureSnapshotHint = getFailureSnapshotHint(responseData?.failure_snapshot_dir);

  if (Number(responseData?.failed_count || 0) > 0 || failedResults.length > 0) {
    const firstFailed = failedResults[0] || null;
    const firstError = firstFailed?.error || "未知错误";
    throw new Error(
      `批次 ${batch.start + 1}-${batch.end} 存在失败帧: ${firstError}${failureSnapshotHint}`
    );
  }

  if (results.length === 0) {
    throw new Error(
      `批次 ${batch.start + 1}-${batch.end} 未返回结果数据，无法继续处理。${failureSnapshotHint}`
    );
  }

  const successFrameIndexes = new Set(
    results
      .filter((item) => item?.success)
      .map((item) => Number(item.frame_index))
      .filter((value) => Number.isFinite(value))
  );
  const missingFrameIndexes = batch.batchItems
    .filter((item) => !successFrameIndexes.has(item.frame_index))
    .map((item) => item.frame_index);

  if (missingFrameIndexes.length > 0) {
    const preview = missingFrameIndexes.slice(0, 8).join("、");
    const suffix = missingFrameIndexes.length > 8 ? " 等" : "";
    throw new Error(
      `批次 ${batch.start + 1}-${batch.end} 后端返回结果不完整，缺少帧 ${preview}${suffix}。${failureSnapshotHint}`
    );
  }

  const missingOutputPaths = await getMissingFilePaths(batch.batchResultPaths);
  if (missingOutputPaths.length > 0) {
    const preview = missingOutputPaths.slice(0, 2).join("；");
    const suffix = missingOutputPaths.length > 2 ? " 等文件" : "";
    throw new Error(
      `批次 ${batch.start + 1}-${batch.end} 的结果文件未生成完成：${preview}${suffix}。${failureSnapshotHint}`
    );
  }
};

const loadVideoFileFromPath = async (filePath) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    throw new Error("当前环境无法读取视频文件");
  }

  const [bytes, statsResult] = await Promise.all([
    readFileBytes(filePath),
    window.electron.ipcRenderer.invoke("get-file-stats", filePath),
  ]);

  const fallbackName = String(filePath || "").split(/[\\/]/).pop() || "video.mp4";
  const file = new File([bytes], statsResult?.data?.name || fallbackName, {
    type: statsResult?.data?.type || getMimeTypeForPath(filePath) || "video/mp4",
    lastModified: Number(statsResult?.data?.lastModified || Date.now()),
  });

  Object.defineProperty(file, "path", {
    configurable: true,
    enumerable: true,
    writable: false,
    value: filePath,
  });

  return file;
};

const waitForVideoReady = async (timeoutMs = VIDEO_READY_TIMEOUT_MS) => {
  await nextTick();
  if (canvasPlayerRef.value?.waitForReady) {
    await canvasPlayerRef.value.waitForReady(timeoutMs);
    await nextTick();
    return;
  }

  await new Promise((resolve) => {
    let settled = false;
    let stop = null;
    const finish = async () => {
      if (settled) return;
      settled = true;
      if (stop) stop();
      await nextTick();
      resolve();
    };

    const timer = window.setTimeout(() => {
      finish();
    }, timeoutMs);

    stop = watch(
      () => [videoStore.videoWidth, videoStore.videoHeight, videoStore.videoDuration],
      ([width, height]) => {
        if (width > 0 && height > 0) {
          window.clearTimeout(timer);
          finish();
        }
      },
      { immediate: true }
    );
  });
};

const beginVideoMountLoading = ({
  message = "正在读取视频信息",
  progress = VIDEO_MOUNT_LOADING_PROGRESS.PREPARE,
  external = false,
} = {}) => {
  const token = ++videoMountLoadingState.token;
  videoMountLoadingState.externallyManaged = external;
  updateGlobalLoadingOverlay(message, progress);
  return token;
};

const isActiveVideoMountLoading = (token) => token === videoMountLoadingState.token;

const updateVideoMountLoading = (token, message, progress = null) => {
  if (!isActiveVideoMountLoading(token)) {
    return false;
  }

  updateGlobalLoadingOverlay(message, progress);
  return true;
};

const finishVideoMountLoading = (token, { forceHide = false } = {}) => {
  if (!isActiveVideoMountLoading(token)) {
    return;
  }

  const shouldHide = forceHide || !videoMountLoadingState.externallyManaged;
  videoMountLoadingState.externallyManaged = false;
  if (shouldHide) {
    hideGlobalLoadingOverlay();
  }
};

const buildTimelineRows = () => {
  if (isSlbrModel.value) {
    return videoStore.processingRanges.map((range) => ({
      id: `processing-range-row-${range.id}`,
      rowHeight: 44,
      classNames: ["timeline-row-range", "timeline-row-processing-range"],
      selected: range.id === videoStore.selectedProcessingRangeId,
      actions: [
        {
          id: `processing-range-${range.id}`,
          start: range.startTime,
          end: range.endTime,
          effectId: "effect-processing-range",
          movable: true,
          flexible: true,
          minStart: 0,
          maxEnd: Math.max(videoStore.videoDuration || 0, 0),
          selected: range.id === videoStore.selectedProcessingRangeId,
          data: {
            kind: "processing-range",
            rangeId: range.id,
            label: range.name,
            color: "#2fb344",
          },
        },
      ],
    }));
  }

  const markerDuration = keyframeMarkerDuration.value;
  return videoStore.masks.flatMap((mask) => {
    const isSamVideoTrack = mask.type === "samVideo";
    const userKeyframes = isSamVideoTrack
      ? []
      : sortMaskKeyframes(mask.keyframes).filter(
          (keyframe) => keyframe.type === MASK_KEYFRAME_TYPES.USER
        );

    const rangeRow = {
      id: `range-row-${mask.id}`,
      rowHeight: 44,
      classNames: ["timeline-row-range"],
      selected: mask.id === videoStore.selectedMaskId,
      actions: [
        {
          id: `range-${mask.id}`,
          start: mask.startTime,
          end: mask.endTime,
          effectId: "effect-mask-range",
          movable: !isSamVideoTrack,
          flexible: !isSamVideoTrack,
          minStart: 0,
          maxEnd: Math.max(videoStore.videoDuration || 0, 0),
          selected: mask.id === videoStore.selectedMaskId,
          data: {
            kind: "mask-range",
            maskId: mask.id,
            label: mask.name,
            color: mask.displayColor,
            locked: isSamVideoTrack,
          },
        },
      ],
    };

    if (userKeyframes.length === 0) {
      return [rangeRow];
    }

    const keyframeRow = {
      id: `keyframe-row-${mask.id}`,
      rowHeight: 20,
      classNames: ["timeline-row-keyframes"],
      actions: userKeyframes.map((keyframe) => ({
        id: `keyframe-${mask.id}-${keyframe.id}`,
        start: keyframe.time,
        end: keyframe.time + markerDuration,
        effectId: "effect-mask-keyframe",
        movable: false,
        flexible: false,
        selected: keyframe.id === videoStore.selectedKeyframeId,
        data: {
          kind: "mask-keyframe",
          maskId: mask.id,
          keyframeId: keyframe.id,
          label: formatSeconds(keyframe.time),
          color: "transparent",
        },
      })),
    };

    return [
      rangeRow,
      keyframeRow,
    ];
  });
};

const syncTimelineRowsFromStore = () => {
  syncingTimelineFromStore = true;
  timelineRows.value = buildTimelineRows();
  nextTick(() => {
    syncingTimelineFromStore = false;
  });
};

watch(
  () => [
    currentModel.value,
    videoStore.masks,
    videoStore.processingRanges,
    videoStore.videoDuration,
    videoStore.selectedMaskId,
    videoStore.selectedProcessingRangeId,
    videoStore.selectedKeyframeId,
  ],
  () => syncTimelineRowsFromStore(),
  { deep: true, immediate: true }
);

watch(
  () => videoStore.videoFile,
  async (file) => {
    const shouldPreserveLastOutputPath = preserveLastOutputPathOnNextVideoChange;
    preserveLastOutputPathOnNextVideoChange = false;
    processingSucceeded.value = false;
    lastOutputIsPreview.value = false;
    if (!shouldPreserveLastOutputPath) {
      lastOutputPath.value = "";
    }

    if (!file) {
      timelineRows.value = [];
      sourceFps.value = 30;
      timelineZoomPercent.value = 0;
      timelineScrollLeft.value = 0;
      timelineViewportWidth.value = 0;
      videoStore.setSourceFrameRate(30);
      if (!videoMountLoadingState.externallyManaged) {
        hideGlobalLoadingOverlay();
      }
      return;
    }

    const mountToken = videoMountLoadingState.externallyManaged
      ? videoMountLoadingState.token
      : beginVideoMountLoading({
          message: "正在读取视频信息",
          progress: VIDEO_MOUNT_LOADING_PROGRESS.PREPARE,
        });

    try {
      sourceFps.value = await estimateFpsFromVideo(file);
      if (!isActiveVideoMountLoading(mountToken)) return;

      videoStore.setSourceFrameRate(sourceFps.value);
      timelineZoomPercent.value = 0;
      timelineScrollLeft.value = 0;

      updateVideoMountLoading(
        mountToken,
        "正在挂载视频预览",
        VIDEO_MOUNT_LOADING_PROGRESS.PREVIEW
      );
      await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);
      if (!isActiveVideoMountLoading(mountToken)) return;

      updateVideoMountLoading(
        mountToken,
        "正在初始化时间轴",
        VIDEO_MOUNT_LOADING_PROGRESS.TIMELINE
      );
      await nextTick();
      updateLayoutMetrics();
      syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
      updateVideoMountLoading(
        mountToken,
        "正在完成页面准备",
        VIDEO_MOUNT_LOADING_PROGRESS.FINALIZE
      );
    } catch (error) {
      if (isActiveVideoMountLoading(mountToken)) {
        console.warn("Failed to prepare video page:", error);
        $q.notify({
          type: "warning",
          message: `视频加载可能未完成：${error.message}`,
          position: "top",
          timeout: 3000,
        });
      }
    } finally {
      if (isActiveVideoMountLoading(mountToken) && !videoMountLoadingState.externallyManaged) {
        finishVideoMountLoading(mountToken);
      }
    }
  }
);

watch(
  () => videoStore.currentSourcePath || videoStore.videoFile?.path || "",
  async (newSourcePath, previousSourcePath) => {
    if (
      suppressSourceCleanupWatcher ||
      isProcessing.value ||
      !previousSourcePath ||
      previousSourcePath === newSourcePath
    ) {
      return;
    }

    try {
      await discardLatestResumableTaskForSourcePath({
        sourcePath: previousSourcePath,
        nextSourcePath: newSourcePath,
      });
    } catch (error) {
      console.warn("Failed to discard previous resumable task:", error);
    }
  }
);

watch(isProcessing, (processing) => {
  setActiveProcessingTask({
    taskId: VIDEO_PROCESSING_TASK_ID,
    type: "video",
    label: "视频处理任务",
    active: processing,
  });
});

watch(
  () => (videoStore.selectedKeyframe ? `${videoStore.selectedKeyframe.id}:${videoStore.selectedKeyframe.time}` : ""),
  (signature) => {
    if (!signature || !videoStore.selectedKeyframe) return;
    const keyframeTime = Number(videoStore.selectedKeyframe.time || 0);
    if (Math.abs(videoStore.currentTime - keyframeTime) <= 0.0005) return;
    canvasPlayerRef.value?.seekTo(keyframeTime);
  }
);

watch(
  () => videoStore.currentTime,
  (newTime) => {
    if (!isDragging.value) {
      currentProgress.value = newTime;
    }
    syncTimelineViewport({ ensureVisible: true });
  },
  { immediate: true }
);

watch(
  () => [timelineZoomPercent.value, timelineViewportWidth.value, timelineScale.value],
  async () => {
    if (!videoStore.hasVideoFile) return;
    await nextTick();
    syncTimelineViewport({ center: videoStore.currentTime > 0.0005 });
  }
);

watch(
  () => ({
    exportFpsMode: exportFpsMode.value,
    timelineZoomPercent: timelineZoomPercent.value,
    timelineScrollLeft: timelineScrollLeft.value,
    previewTrialSeconds: previewTrialSeconds.value,
    currentModel: currentModel.value,
    modelParameterValues: modelParameterValues.value,
    resourceManageTab: normalizeVideoResourceTab(resourceManageTab.value),
    videoEditorSections: normalizeVideoEditorSections(videoEditorSections.value),
    playbackRate: videoStore.playbackRate,
    isMuted: videoStore.isMuted,
  }),
  () => {
    if (!canPersistVideoUiState) return;
    persistVideoUiStateToAppState();
  },
  { deep: true }
);

watch(
  () => isFullscreenLamaViewportMode.value || isFullscreenSamViewportMode.value,
  (enabled) => {
    if (enabled) return;
    clearFullscreenZoomSessionTimer();
    clearFullscreenPlaybackPauseSessions();
    finishFullscreenViewportPan();
    showFullscreenDrawingToolbar.value = false;
    fullscreenMaskPreviewVisible.value = true;
    resetFullscreenViewport();
  }
);

watch(
  () => selectedSamVideoResultObjects.value.length,
  (count) => {
    if (count === 0) {
      samVideoCandidateMenuOpen.value = false;
    }
  }
);

watch(
  () => defaultSamVideoModelId.value,
  (modelId) => {
    if (!samVideoSessionModelId.value && modelId) {
      samVideoSessionModelId.value = modelId;
      return;
    }
    if (
      samVideoSessionModelId.value &&
      !samVideoModelOptions.value.some((option) => option.value === samVideoSessionModelId.value)
    ) {
      samVideoSessionModelId.value = modelId;
    }
  },
  { immediate: true }
);

const handlePlayPause = () => canvasPlayerRef.value?.togglePlayPause();
const handleStop = () => canvasPlayerRef.value?.stop();
const handlePreviousFrame = () => canvasPlayerRef.value?.previousFrame();
const handleNextFrame = () => canvasPlayerRef.value?.nextFrame();

const handleToggleMute = () => {
  videoStore.setIsMuted(!videoStore.isMuted);
};

const handlePlaybackRateChange = (rate) => {
  videoStore.setPlaybackRate(rate);
  if (videoStore.isPlaying && canvasPlayerRef.value) {
    canvasPlayerRef.value.play();
  }
};

const createTransparentMaskDataUrl = (width, height) => {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.floor(Number(width || 1)));
  canvas.height = Math.max(1, Math.floor(Number(height || 1)));
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  return canvas.toDataURL("image/png");
};

const clearSelectedMaskForFullscreenToolbar = () => {
  if (!videoStore.selectedMaskId || !videoStore.videoWidth || !videoStore.videoHeight) {
    return;
  }
  const transparentMask = createTransparentMaskDataUrl(
    videoStore.videoWidth,
    videoStore.videoHeight
  );
  videoStore.commitSelectedMaskBaseMask(transparentMask);
};

const normalizeFullscreenViewportScale = (value) =>
  Math.max(0.5, Math.min(5, Number(value || 1)));

const resetFullscreenViewport = () => {
  fullscreenViewportState.value = {
    scale: 1,
    offsetX: 0,
    offsetY: 0,
  };
};

const getPreviewStageRect = () =>
  unwrapElement(previewStageWrapRef.value)?.getBoundingClientRect() || null;

const getFullscreenDrawingToolbarElement = () =>
  fullscreenDrawingToolbarRef.value?.getRootElement?.() ||
  unwrapElement(fullscreenDrawingToolbarRef.value);

const getFullscreenDrawingToolbarRect = () =>
  getFullscreenDrawingToolbarElement()?.getBoundingClientRect() || null;

const setFullscreenMaskPreviewVisible = (visible = true) => {
  fullscreenMaskPreviewVisible.value = Boolean(visible);
};

const clampFullscreenDrawingToolbarPosition = ({ x, y } = {}) => {
  const stageRect = getPreviewStageRect();
  const toolbarRect = getFullscreenDrawingToolbarRect();
  if (!stageRect) {
    return {
      x: Math.max(12, Number(x || 0)),
      y: Math.max(12, Number(y || 0)),
    };
  }

  const toolbarWidth = Math.max(220, toolbarRect?.width || 220);
  const toolbarHeight = Math.max(88, toolbarRect?.height || 88);
  const minX = 12;
  const minY = 12;
  const maxX = Math.max(minX, stageRect.width - toolbarWidth - 12);
  const maxY = Math.max(minY, stageRect.height - toolbarHeight - 12);

  return {
    x: Math.min(maxX, Math.max(minX, Number(x || 0))),
    y: Math.min(maxY, Math.max(minY, Number(y || 0))),
  };
};

const placeFullscreenDrawingToolbarToDefault = async () => {
  fullscreenDrawingToolbarPosition.value = {
    x: 24,
    y: 24,
  };
  await nextTick();
  const stageRect = getPreviewStageRect();
  const toolbarRect = getFullscreenDrawingToolbarRect();
  const toolbarWidth = Math.max(220, toolbarRect?.width || 220);
  const toolbarHeight = Math.max(88, toolbarRect?.height || 88);
  const stageWidth = stageRect?.width || 0;
  const stageHeight = stageRect?.height || 0;
  const centeredX = Math.max(12, (stageWidth - toolbarWidth) / 2);
  const bottomY = Math.max(12, stageHeight - toolbarHeight - 18);

  fullscreenDrawingToolbarPosition.value = {
    x: centeredX,
    y: bottomY,
  };
  fullscreenDrawingToolbarPosition.value = clampFullscreenDrawingToolbarPosition(
    fullscreenDrawingToolbarPosition.value
  );
};

const clearFullscreenPlaybackPauseSessions = () => {
  fullscreenPlaybackPauseSessions.clear();
  fullscreenPlaybackResumeRequested = false;
};

const beginFullscreenPlaybackPauseSession = (key) => {
  if (!isFullscreenLamaViewportMode.value || fullscreenPlaybackPauseSessions.has(key)) {
    return;
  }

  const shouldResume = Boolean(videoStore.isPlaying);
  fullscreenPlaybackPauseSessions.set(key, shouldResume);
  if (shouldResume) {
    fullscreenPlaybackResumeRequested = true;
    canvasPlayerRef.value?.pause?.();
  }
};

const endFullscreenPlaybackPauseSession = (key) => {
  if (!fullscreenPlaybackPauseSessions.has(key)) {
    return;
  }

  fullscreenPlaybackPauseSessions.delete(key);
  if (fullscreenPlaybackPauseSessions.size > 0) {
    return;
  }

  if (fullscreenPlaybackResumeRequested) {
    canvasPlayerRef.value?.play?.();
  }
  fullscreenPlaybackResumeRequested = false;
};

const clearPreviewFullscreenExitTimer = () => {
  if (!previewFullscreenExitTimerId) return;
  window.clearTimeout(previewFullscreenExitTimerId);
  previewFullscreenExitTimerId = 0;
};

const clearFullscreenBottomControlsHideTimer = () => {
  if (!previewFullscreenBottomControlsTimerId) return;
  window.clearTimeout(previewFullscreenBottomControlsTimerId);
  previewFullscreenBottomControlsTimerId = 0;
};

const clearFullscreenZoomSessionTimer = () => {
  if (!fullscreenZoomSessionTimerId) return;
  window.clearTimeout(fullscreenZoomSessionTimerId);
  fullscreenZoomSessionTimerId = 0;
};

const showFullscreenExitOverlay = () => {
  if (!isPreviewFullscreen.value) return;
  clearPreviewFullscreenExitTimer();
  showFullscreenExitButton.value = true;
};

const scheduleHideFullscreenExitOverlay = (delayMs = 220) => {
  if (!isPreviewFullscreen.value) return;
  clearPreviewFullscreenExitTimer();
  previewFullscreenExitTimerId = window.setTimeout(() => {
    showFullscreenExitButton.value = false;
    previewFullscreenExitTimerId = 0;
  }, Math.max(0, Number(delayMs || 0)));
};

const showFullscreenBottomOverlay = () => {
  if (!isPreviewFullscreen.value) return;
  clearFullscreenBottomControlsHideTimer();
  showFullscreenBottomControls.value = true;
};

const scheduleHideFullscreenBottomOverlay = (delayMs = 1400) => {
  if (!isPreviewFullscreen.value) return;
  clearFullscreenBottomControlsHideTimer();
  previewFullscreenBottomControlsTimerId = window.setTimeout(() => {
    showFullscreenBottomControls.value = false;
    previewFullscreenBottomControlsTimerId = 0;
  }, Math.max(0, Number(delayMs || 0)));
};

const isPointerInPreviewCanvasArea = (event) => {
  if (!event) return false;
  const stageRect = canvasPlayerRef.value?.getStageRect?.();
  if (!stageRect) return false;
  return (
    event.clientX >= stageRect.left &&
    event.clientX <= stageRect.right &&
    event.clientY >= stageRect.top &&
    event.clientY <= stageRect.bottom
  );
};

const applyFullscreenViewportPan = (nextOffsetX, nextOffsetY) => {
  fullscreenViewportState.value = {
    ...fullscreenViewportState.value,
    offsetX: Number(nextOffsetX || 0),
    offsetY: Number(nextOffsetY || 0),
  };
};

const handleFullscreenDrawStart = () => {
  if (!isFullscreenLamaViewportMode.value && !isFullscreenSamViewportMode.value) return;
  beginFullscreenPlaybackPauseSession("draw");
};

const handleFullscreenDrawEnd = () => {
  endFullscreenPlaybackPauseSession("draw");
};

const finishFullscreenViewportPan = (shouldTogglePlayPause = false) => {
  if (!fullscreenViewportPanContext) return;
  window.removeEventListener("pointermove", handleFullscreenViewportPointerMove, true);
  window.removeEventListener("pointerup", handleFullscreenViewportPointerUp, true);

  const hasMoved = Boolean(fullscreenViewportPanContext.moved);
  fullscreenViewportPanContext = null;
  if (hasMoved) {
    endFullscreenPlaybackPauseSession("pan");
    return;
  }
  if (shouldTogglePlayPause) {
    handlePlayPause();
  }
};

const handleFullscreenViewportPointerMove = (event) => {
  if (!fullscreenViewportPanContext) return;
  if (event.pointerId !== fullscreenViewportPanContext.pointerId) return;

  const dx = Number(event.clientX || 0) - fullscreenViewportPanContext.startClientX;
  const dy = Number(event.clientY || 0) - fullscreenViewportPanContext.startClientY;
  const moved = Math.hypot(dx, dy) >= 3;

  if (moved && !fullscreenViewportPanContext.moved) {
    fullscreenViewportPanContext.moved = true;
    beginFullscreenPlaybackPauseSession("pan");
  }

  if (!fullscreenViewportPanContext.moved) {
    return;
  }

  applyFullscreenViewportPan(
    fullscreenViewportPanContext.startOffsetX + dx,
    fullscreenViewportPanContext.startOffsetY + dy
  );
  event.preventDefault();
};

const handleFullscreenViewportPointerUp = (event) => {
  if (!fullscreenViewportPanContext) return;
  if (event.pointerId !== fullscreenViewportPanContext.pointerId) return;
  finishFullscreenViewportPan(true);
};

const handleFullscreenViewportPointerDown = (event) => {
  if (!isFullscreenLamaViewportMode.value || !isPointerInPreviewCanvasArea(event)) return;
  if (videoStore.maskTool.drawingEnabled || event.button !== 0) return;

  fullscreenViewportPanContext = {
    pointerId: event.pointerId,
    startClientX: Number(event.clientX || 0),
    startClientY: Number(event.clientY || 0),
    startOffsetX: Number(fullscreenViewportState.value.offsetX || 0),
    startOffsetY: Number(fullscreenViewportState.value.offsetY || 0),
    moved: false,
  };
  window.addEventListener("pointermove", handleFullscreenViewportPointerMove, true);
  window.addEventListener("pointerup", handleFullscreenViewportPointerUp, true);
};

const handleFullscreenViewportWheel = (event) => {
  if (
    (!isFullscreenLamaViewportMode.value && !isFullscreenSamViewportMode.value) ||
    !isPointerInPreviewCanvasArea(event)
  ) {
    return;
  }
  event.preventDefault();

  const stageRect = canvasPlayerRef.value?.getStageRect?.();
  if (!stageRect) return;
  const currentScale = normalizeFullscreenViewportScale(fullscreenViewportState.value.scale);
  const nextScale = normalizeFullscreenViewportScale(
    event.deltaY < 0 ? currentScale * 1.08 : currentScale * 0.92
  );
  if (Math.abs(nextScale - currentScale) < 0.0005) return;

  beginFullscreenPlaybackPauseSession("zoom");
  clearFullscreenZoomSessionTimer();
  fullscreenZoomSessionTimerId = window.setTimeout(() => {
    fullscreenZoomSessionTimerId = 0;
    endFullscreenPlaybackPauseSession("zoom");
  }, 260);

  const cursorOffsetX = Number(event.clientX || 0) - stageRect.left;
  const cursorOffsetY = Number(event.clientY || 0) - stageRect.top;
  const ratio = nextScale / currentScale;
  const offsetX =
    Number(fullscreenViewportState.value.offsetX || 0) - cursorOffsetX * (ratio - 1);
  const offsetY =
    Number(fullscreenViewportState.value.offsetY || 0) - cursorOffsetY * (ratio - 1);

  fullscreenViewportState.value = {
    scale: nextScale,
    offsetX,
    offsetY,
  };
};

const startFullscreenDrawingToolbarDrag = (event) => {
  if (!isFullscreenLamaViewportMode.value && !isFullscreenSamViewportMode.value) return;
  if (typeof event?.pointerId !== "number") return;
  fullscreenDrawingToolbarDragContext = {
    pointerId: event.pointerId,
    startClientX: Number(event.clientX || 0),
    startClientY: Number(event.clientY || 0),
    startX: Number(fullscreenDrawingToolbarPosition.value.x || 0),
    startY: Number(fullscreenDrawingToolbarPosition.value.y || 0),
  };
  window.addEventListener("pointermove", handleFullscreenDrawingToolbarDragMove, true);
  window.addEventListener("pointerup", stopFullscreenDrawingToolbarDrag, true);
};

const handleFullscreenDrawingToolbarDragMove = (event) => {
  if (!fullscreenDrawingToolbarDragContext) return;
  if (event.pointerId !== fullscreenDrawingToolbarDragContext.pointerId) return;
  const dx = Number(event.clientX || 0) - fullscreenDrawingToolbarDragContext.startClientX;
  const dy = Number(event.clientY || 0) - fullscreenDrawingToolbarDragContext.startClientY;
  fullscreenDrawingToolbarPosition.value = clampFullscreenDrawingToolbarPosition({
    x: fullscreenDrawingToolbarDragContext.startX + dx,
    y: fullscreenDrawingToolbarDragContext.startY + dy,
  });
};

const stopFullscreenDrawingToolbarDrag = (event) => {
  if (!fullscreenDrawingToolbarDragContext) return;
  if (event.pointerId !== fullscreenDrawingToolbarDragContext.pointerId) return;
  fullscreenDrawingToolbarDragContext = null;
  window.removeEventListener("pointermove", handleFullscreenDrawingToolbarDragMove, true);
  window.removeEventListener("pointerup", stopFullscreenDrawingToolbarDrag, true);
};

const toggleFullscreenDrawingToolbar = () => {
  if (!isPreviewFullscreen.value || fullscreenDrawingToolbarToggleDisabled.value) return;
  if (!isFullscreenLamaViewportMode.value && !isFullscreenSamViewportMode.value) return;
  showFullscreenDrawingToolbar.value = !showFullscreenDrawingToolbar.value;
};

const handleFullscreenDrawingToolbarToggle = () => {
  toggleFullscreenDrawingToolbar();
};

const handleFullscreenHoverMove = (event) => {
  if (!isPreviewFullscreen.value) return;
  const target = unwrapElement(previewStageWrapRef.value);
  if (!(target instanceof HTMLElement) || !event) return;

  const rect = target.getBoundingClientRect();
  const localX = Number(event.clientX || 0) - rect.left;
  const localY = Number(event.clientY || 0) - rect.top;

  const topZoneWidth = Math.max(180, Math.min(260, rect.width * 0.42));
  const topZoneHeight = Math.max(56, Math.min(96, rect.height * 0.24));
  const topZoneLeft = (rect.width - topZoneWidth) / 2;
  const topZoneRight = topZoneLeft + topZoneWidth;
  const insideTopCenterZone =
    localX >= topZoneLeft &&
    localX <= topZoneRight &&
    localY >= 0 &&
    localY <= topZoneHeight;

  if (insideTopCenterZone) {
    showFullscreenExitOverlay();
  } else if (showFullscreenExitButton.value) {
    scheduleHideFullscreenExitOverlay(160);
  }

  const bottomZoneHeight = Math.max(70, Math.min(110, rect.height * 0.22));
  const insideBottomZone = localY >= rect.height - bottomZoneHeight && localY <= rect.height;
  if (insideBottomZone) {
    showFullscreenBottomOverlay();
  } else if (showFullscreenBottomControls.value) {
    scheduleHideFullscreenBottomOverlay(1400);
  }
};

const handleFullscreenHoverLeave = () => {
  scheduleHideFullscreenExitOverlay(120);
  scheduleHideFullscreenBottomOverlay(1400);
};

const isPreviewFullscreenActive = () =>
  document.fullscreenElement === unwrapElement(previewStageWrapRef.value);

const togglePreviewFullscreen = async () => {
  const target = unwrapElement(previewStageWrapRef.value);
  if (!(target instanceof HTMLElement) || !document.fullscreenEnabled) {
    return;
  }

  try {
    if (isPreviewFullscreenActive()) {
      await document.exitFullscreen();
    } else {
      await target.requestFullscreen();
      showFullscreenExitButton.value = false;
      showFullscreenBottomControls.value = false;
    }
  } catch (error) {
    console.warn("Failed to toggle preview fullscreen:", error);
  }
};

const exitPreviewFullscreenIfNeeded = async () => {
  if (!isPreviewFullscreenActive()) {
    return;
  }

  try {
    await document.exitFullscreen();
  } catch {
    // Ignore fullscreen exit failures during navigation/unmount.
  }
};

const handleDocumentFullscreenChange = async () => {
  const active = isPreviewFullscreenActive();
  isPreviewFullscreen.value = active;
  if (!active) {
    clearPreviewFullscreenExitTimer();
    clearFullscreenBottomControlsHideTimer();
    clearFullscreenZoomSessionTimer();
    showFullscreenExitButton.value = false;
    showFullscreenBottomControls.value = false;
    showFullscreenDrawingToolbar.value = false;
    fullscreenMaskPreviewVisible.value = true;
    clearFullscreenPlaybackPauseSessions();
    stopFullscreenDrawingToolbarDrag({
      pointerId: fullscreenDrawingToolbarDragContext?.pointerId,
    });
    finishFullscreenViewportPan();
    resetFullscreenViewport();
  } else {
    resetFullscreenViewport();
    fullscreenMaskPreviewVisible.value = true;
    if (currentModelRequiresMask.value || selectedMaskIsSamVideo.value) {
      showFullscreenDrawingToolbar.value = selectedMaskIsSamVideo.value
        ? true
        : Boolean(videoStore.maskTool.drawingEnabled);
      await placeFullscreenDrawingToolbarToDefault();
    } else {
      showFullscreenDrawingToolbar.value = false;
    }
  }
  scheduleLayoutMetricsUpdate();
};
const handleProgressDrag = (details) => {
  if (details.isFirst) {
    isDragging.value = true;
    if (videoStore.isPlaying) {
      canvasPlayerRef.value?.pause();
    }
  } else if (details.isFinal) {
    isDragging.value = false;
  }
};

const handleProgressChange = (value) => {
  if (!videoStore.hasVideoFile) return;
  canvasPlayerRef.value?.seekTo(value);
};

const handleTimelineTimeUpdate = (time) => {
  if (!videoStore.hasVideoFile || isDragging.value || isProcessing.value) return;
  if (Math.abs(time - videoStore.currentTime) < 0.02) return;
  currentProgress.value = time;
  canvasPlayerRef.value?.seekTo(time);
};

const handleTimelineScroll = ({ scrollLeft }) => {
  timelineScrollLeft.value = scrollLeft;
};

const handleTimelineActionClick = (_event, params) => {
  if (isProcessing.value) return;
  const action = params?.action;
  if (!action?.data) return;

  if (action.data.kind === "mask-range") {
    videoStore.selectMask(action.data.maskId, null);
    return;
  }

  if (action.data.kind === "processing-range") {
    videoStore.selectProcessingRange(action.data.rangeId);
    return;
  }

  if (action.data.kind === "mask-keyframe") {
    videoStore.selectKeyframe(action.data.maskId, action.data.keyframeId);
  }
};

const handleTimelineModelChange = (rows) => {
  if (syncingTimelineFromStore || isProcessing.value) return;
  timelineRows.value = rows;
};

const confirmOverflowKeyframeDeletion = (overflowKeyframes = []) =>
  new Promise((resolve) => {
    const timeList = overflowKeyframes.map((item) => formatSeconds(item.time)).join("、");
    $q.dialog({
      title: "删除越界关键帧？",
      message:
        overflowKeyframes.length > 0
          ? `调整后的蒙版区间会删除 ${overflowKeyframes.length} 个越界关键帧：${timeList}`
          : "调整后的蒙版区间会删除越界关键帧。",
      ok: {
        label: "删除",
        color: "primary",
        unelevated: true,
      },
      cancel: {
        label: "取消",
        flat: true,
      },
      persistent: true,
    })
      .onOk(() => resolve(true))
      .onCancel(() => resolve(false))
      .onDismiss(() => resolve(false));
  });

const commitTimelineRangeResize = async (action) => {
  const maskId = action?.data?.maskId;
  if (!maskId) {
    syncTimelineRowsFromStore();
    return;
  }

  const result = videoStore.resizeMaskRange(
    maskId,
    {
      startTime: action.start,
      endTime: action.end,
    },
    {
      deleteOverflow: false,
    }
  );

  if (!result.ok && result.code === "overflow-user-keyframes") {
    const confirmed = await confirmOverflowKeyframeDeletion(result.overflowKeyframes);
    if (!confirmed) {
      syncTimelineRowsFromStore();
      return;
    }

    videoStore.resizeMaskRange(
      maskId,
      {
        startTime: result.startTime,
        endTime: result.endTime,
      },
      {
        deleteOverflow: true,
      }
    );
    syncTimelineRowsFromStore();
    return;
  }

  if (!result.ok) {
    $q.notify({
      type: "warning",
      message: result.error || "蒙版区间调整失败。",
      timeout: 2500,
    });
  }

  syncTimelineRowsFromStore();
};

const handleTimelineActionMoveEnd = (params) => {
  if (isProcessing.value) {
    syncTimelineRowsFromStore();
    return;
  }

  const action = params?.action;
  if (action?.data?.kind === "processing-range") {
    const range = videoStore.getProcessingRangeById(action.data.rangeId);
    if (!range) {
      syncTimelineRowsFromStore();
      return;
    }
    const delta = Number(action.start || 0) - Number(range.startTime || 0);
    const result = videoStore.moveProcessingRange(range.id, delta);
    if (!result.ok) {
      $q.notify({
        type: "warning",
        message: result.error || "处理范围移动失败。",
        timeout: 2500,
      });
    }
    syncTimelineRowsFromStore();
    return;
  }

  if (action?.data?.kind !== "mask-range") {
    syncTimelineRowsFromStore();
    return;
  }

  const mask = videoStore.getMaskById(action.data.maskId);
  if (!mask) {
    syncTimelineRowsFromStore();
    return;
  }

  const delta = Number(action.start || 0) - Number(mask.startTime || 0);
  const result = videoStore.moveMaskRange(mask.id, delta);
  if (!result.ok) {
    $q.notify({
      type: "warning",
      message: result.error || "蒙版区间移动失败。",
      timeout: 2500,
    });
  }
  syncTimelineRowsFromStore();
};

const handleTimelineActionResizeEnd = async (params) => {
  if (isProcessing.value) {
    syncTimelineRowsFromStore();
    return;
  }

  const action = params?.action;
  if (action?.data?.kind === "processing-range") {
    const result = videoStore.resizeProcessingRange(action.data.rangeId, {
      startTime: action.start,
      endTime: action.end,
    });
    if (!result.ok) {
      $q.notify({
        type: "warning",
        message: result.error || "处理范围调整失败。",
        timeout: 2500,
      });
    }
    syncTimelineRowsFromStore();
    return;
  }

  if (action?.data?.kind !== "mask-range") {
    syncTimelineRowsFromStore();
    return;
  }

  await commitTimelineRangeResize(action);
};

const replaceCurrentVideoSource = async () => {
  if (!canReplaceCurrentSource.value || !videoStore.videoFile) return;

  const mountToken = beginVideoMountLoading({
    message: "正在加载导出视频文件",
    progress: 0.2,
    external: true,
  });

  try {
    const historyLimit = getConfiguredVideoHistoryLimit();
    if (videoStore.videoHistory.length >= historyLimit) {
      const confirmed = await confirmHistoryTrim();
      if (!confirmed) return;
    }

    const nextFile = await loadVideoFileFromPath(lastOutputPath.value);
    const currentEntry = videoStore.buildHistoryEntry({
      uiState: captureVideoUiState(),
    });
    videoStore.pushHistoryEntry(currentEntry, historyLimit);

    preserveLastOutputPathOnNextVideoChange = true;
    updateVideoMountLoading(mountToken, "正在切换当前视频源", 0.44);
    await videoStore.setVideoFile(nextFile, {
      resetEditor: true,
      resetHistory: false,
      isReplacementSource: true,
      sourcePath: lastOutputPath.value,
      sourceName: nextFile.name || videoStore.currentSourceName || "",
    });

    exportFpsMode.value = "source";
    timelineZoomPercent.value = 0;
    timelineScrollLeft.value = 0;
    processingSucceeded.value = false;
    processingMessage.value = "";
    processingPhase.value = VIDEO_PROCESSING_PHASES.IDLE;

    await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);
    updateVideoMountLoading(mountToken, "正在恢复预览位置", VIDEO_MOUNT_LOADING_PROGRESS.FINALIZE);
    await canvasPlayerRef.value?.seekTo(0);
    syncTimelineRowsFromStore();
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `替换视频失败: ${error.message}`,
      position: "top",
      timeout: 3000,
    });
  } finally {
    finishVideoMountLoading(mountToken, { forceHide: true });
  }
};

const restoreVideoHistory = async (entryId) => {
  const mountToken = beginVideoMountLoading({
    message: "正在恢复历史视频",
    progress: 0.18,
    external: true,
  });

  try {
    const targetEntry = videoStore.videoHistory.find((item) => item.id === entryId);
    if (!targetEntry) return;

    if (targetEntry.filePath) {
      const exists = await ensureFileExists(targetEntry.filePath);
      if (!exists) {
        $q.notify({
          type: "warning",
          message: "视频文件已不存在",
          position: "top",
          timeout: 2500,
        });
        return;
      }
    }

    const nextFile =
      targetEntry.videoFile ||
      (targetEntry.filePath ? await loadVideoFileFromPath(targetEntry.filePath) : null);
    if (!nextFile) {
      $q.notify({
        type: "warning",
        message: "无法恢复该历史记录对应的视频文件",
        position: "top",
        timeout: 2500,
      });
      return;
    }

    await videoStore.setVideoFile(nextFile, {
      resetEditor: true,
      resetHistory: false,
      isReplacementSource: Boolean(targetEntry.isReplacement),
      sourcePath: targetEntry.filePath || nextFile.path || "",
      sourceName: targetEntry.fileName || nextFile.name || "",
    });

    await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);

    const restored = videoStore.restoreEditorSnapshot(targetEntry.snapshot, {
      preserveVideoInfo: true,
    });
    processingSucceeded.value = false;
    lastOutputPath.value = "";
    processingMessage.value = "";
    processingPhase.value = VIDEO_PROCESSING_PHASES.IDLE;

    updateVideoMountLoading(mountToken, "正在恢复历史编辑状态", 0.95);
    await waitForVideoReady(VIDEO_READY_TIMEOUT_MS);
    await restoreVideoUiState(restored.uiState);
    const seekSucceeded = await canvasPlayerRef.value?.seekTo(
      Number(targetEntry.snapshot?.currentTime || 0)
    );
    if (seekSucceeded === false) {
      throw new Error("播放器未能恢复到历史记录时间点");
    }
    videoStore.removeHistoryFrom(entryId);
    syncTimelineRowsFromStore();
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `恢复历史记录失败: ${error.message}`,
      position: "top",
      timeout: 3000,
    });
  } finally {
    finishVideoMountLoading(mountToken, { forceHide: true });
  }
};

const adjustPlayerSize = () => {
  const target = unwrapElement(previewStageWrapRef.value);
  if (!(target instanceof HTMLElement)) return;

  const availableWidth = Math.max(
    0,
    Math.floor(target.clientWidth || target.getBoundingClientRect().width || 0)
  );
  const availableHeight = Math.max(
    0,
    Math.floor(target.clientHeight || target.getBoundingClientRect().height || 0)
  );
  videoStore.adjustPlayerSize(availableWidth, availableHeight);
};

const observePreviewStageSize = () => {
  disconnectPreviewStageResizeObserver();

  const target = unwrapElement(previewStageWrapRef.value);
  if (!(target instanceof HTMLElement) || typeof ResizeObserver === "undefined") {
    return;
  }

  previewStageResizeObserver = new ResizeObserver(() => {
    scheduleLayoutMetricsUpdate();
  });
  previewStageResizeObserver.observe(target);
};

const INPUT_FRAME_QUALITY = 0.92;
const RESULT_FRAME_FORMAT = "jpg";
const FRAME_CAPTURE_FALLBACK_EPSILON_SECONDS = 0.002;
let mp4ExportSupportChecked = false;

const normalizeImageFormat = (format, fallback = "jpg") => {
  const normalized = String(format || fallback).toLowerCase();
  if (["jpg", "jpeg", "png", "webp"].includes(normalized)) {
    return normalized === "jpeg" ? "jpg" : normalized;
  }
  return fallback;
};

const getMimeTypeForFormat = (format) => {
  switch (normalizeImageFormat(format)) {
    case "png":
      return "image/png";
    case "webp":
      return "image/webp";
    default:
      return "image/jpeg";
  }
};

const joinRendererPath = (...parts) => {
  const normalizedParts = parts.filter((part) => typeof part === "string" && part.length > 0);
  if (normalizedParts.length === 0) return "";
  if (window.electron?.ipcRenderer?.joinPath) {
    return window.electron.ipcRenderer.joinPath(...normalizedParts);
  }
  return normalizedParts.join("/").replace(/\/+/g, "/");
};

const writeJsonToPath = async (filePath, data) => {
  if (!filePath || !window.electron?.ipcRenderer?.writeFile) return;
  await window.electron.ipcRenderer.writeFile(filePath, `${JSON.stringify(data, null, 2)}\n`);
};

const readTextFromPath = async (filePath) => {
  if (!filePath || !window.electron?.ipcRenderer?.invoke) {
    return "";
  }

  const result = await window.electron.ipcRenderer.invoke("read-file", filePath);
  if (!result?.success || !Array.isArray(result?.data?.buffer)) {
    return "";
  }

  return new TextDecoder().decode(new Uint8Array(result.data.buffer));
};

const readJsonFromPath = async (filePath, fallbackValue = null) => {
  const text = await readTextFromPath(filePath);
  if (!text.trim()) {
    return fallbackValue;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn("Failed to parse JSON file:", filePath, error);
    return fallbackValue;
  }
};

const getVideoProcessingRegistryPath = async () => {
  if (cachedVideoProcessingRegistryPath) {
    return cachedVideoProcessingRegistryPath;
  }

  const result = await window.electron.ipcRenderer.invoke("get-video-processing-registry-path");
  if (!result?.success || !result?.data?.registryPath) {
    throw new Error(result?.error || "无法获取视频处理注册表路径");
  }

  cachedVideoProcessingRegistryPath = result.data.registryPath;
  return cachedVideoProcessingRegistryPath;
};

const readVideoProcessingRegistry = async () => {
  const registryPath = await getVideoProcessingRegistryPath();
  return normalizeVideoProcessingRegistry(
    await readJsonFromPath(registryPath, createEmptyVideoProcessingRegistry())
  );
};

const writeVideoProcessingRegistry = async (registry) => {
  const registryPath = await getVideoProcessingRegistryPath();
  await writeJsonToPath(registryPath, normalizeVideoProcessingRegistry(registry));
};

const buildVideoTaskMetaPath = (taskRoot) =>
  joinRendererPath(taskRoot, VIDEO_TASK_META_FILE_NAME);

const buildVideoTaskSummary = (taskMeta) => ({
  taskId: taskMeta.taskId,
  fingerprint: taskMeta.fingerprint,
  taskRoot: taskMeta.taskRoot,
  tempBase: taskMeta.tempBase,
  sourcePath: taskMeta.sourcePath,
  sourceName: taskMeta.sourceName,
  temporarySourcePath: taskMeta.temporarySourcePath,
  status: taskMeta.status,
  previewTrial: taskMeta.previewTrial === true,
  previewTrialSeconds: Math.max(0, Number(taskMeta.previewTrialSeconds || 0)),
  createdAt: taskMeta.createdAt,
  updatedAt: taskMeta.updatedAt,
});

const persistVideoTaskMeta = async (taskMetaInput) => {
  const taskMeta = normalizeVideoTaskMeta({
    ...taskMetaInput,
    updatedAt: Date.now(),
  });
  const metaPath = buildVideoTaskMetaPath(taskMeta.taskRoot);
  await writeJsonToPath(metaPath, taskMeta);

  const registry = await readVideoProcessingRegistry();
  await writeVideoProcessingRegistry(
    upsertVideoProcessingRegistryTask(registry, buildVideoTaskSummary(taskMeta))
  );

  return taskMeta;
};

const removeVideoTaskFromRegistry = async (taskId) => {
  if (!taskId) return;
  const registry = await readVideoProcessingRegistry();
  await writeVideoProcessingRegistry(removeVideoProcessingRegistryTask(registry, taskId));
};

const readVideoTaskMetaFromRoot = async (taskRoot) => {
  if (!taskRoot) {
    return null;
  }

  const taskMeta = await readJsonFromPath(buildVideoTaskMetaPath(taskRoot), null);
  if (!taskMeta) {
    return null;
  }

  const normalized = normalizeVideoTaskMeta(taskMeta);
  return normalized.taskId ? normalized : null;
};

const removeVideoTaskArtifacts = async (taskMeta, { preserveTemporarySourcePath = "" } = {}) => {
  if (!taskMeta?.taskRoot || !window.electron?.ipcRenderer?.invoke) {
    return;
  }

  const shouldRemoveTemporarySource =
    taskMeta.temporarySourcePath &&
    taskMeta.temporarySourcePath !== preserveTemporarySourcePath;
  const results = await Promise.allSettled([
    window.electron.ipcRenderer.invoke("remove-directory-recursive", taskMeta.taskRoot),
    shouldRemoveTemporarySource
      ? window.electron.ipcRenderer.invoke("cleanup-temp-file", taskMeta.temporarySourcePath)
      : Promise.resolve({ success: true }),
  ]);

  const firstError = results.find(
    (item) =>
      item.status === "rejected" ||
      (item.status === "fulfilled" && item.value?.success === false)
  );

  if (firstError?.status === "rejected") {
    throw firstError.reason;
  }

  if (firstError?.status === "fulfilled") {
    throw new Error(firstError.value?.error || "删除任务临时文件失败");
  }
};

const discardVideoTask = async (taskMeta, options = {}) => {
  if (!taskMeta?.taskId) return;
  await removeVideoTaskArtifacts(taskMeta, options);
  await removeVideoTaskFromRegistry(taskMeta.taskId);
};

const resolveConfiguredTempBase = (sourcePath) =>
  configStore.config.fileManagement?.tempPath || sourcePath.replace(/[\\/][^\\/]+$/, "");

const computeVideoFileFingerprint = async (filePath) => {
  const result = await window.electron.ipcRenderer.invoke(
    "compute-video-file-fingerprint",
    filePath
  );

  if (!result?.success || !result?.data?.fingerprint) {
    throw new Error(result?.error || "无法计算视频内容指纹");
  }

  return result.data;
};

const buildCurrentProcessingConfigSnapshot = ({ fps, batchSize, frameFormat }) =>
  buildProcessingConfigSnapshot({
    fps,
    exportFpsMode: exportFpsMode.value,
    batchSize,
    frameFormat,
    modelId: currentModel.value,
    modelOptions: getCurrentModelOptionsPayload(),
    masks: videoStore.masks,
    processingRanges: videoStore.processingRanges,
    videoWidth: videoStore.videoWidth,
    videoHeight: videoStore.videoHeight,
    videoDuration: videoStore.videoDuration,
    defaultModel: configStore.config.general?.defaultModel || "",
  });

const getConfiguredPreviewTrialSeconds = () => {
  const configured = Number(
    previewTrialSeconds.value || configStore.config.video?.previewTrialSeconds || 3
  );
  if (VIDEO_PREVIEW_TRIAL_DURATIONS.includes(configured)) {
    return configured;
  }
  return 3;
};

const getOutputDirectory = (sourcePath) => {
  const downloadPath = configStore.config.fileManagement?.downloadPath || "";
  const videoFolderName = configStore.config.fileManagement?.videoFolderName || "videos";
  if (downloadPath) {
    return joinRendererPath(downloadPath, videoFolderName);
  }
  return sourcePath.replace(/[\\/][^\\/]+$/, "");
};

const estimateVideoDiskUsage = ({
  sourceSize = 0,
  frameCount = 0,
  width = 0,
  height = 0,
  hasMask = false,
  hasSamAssets = false,
  outputDir = "",
  tempBase = "",
} = {}) => {
  const pixelCount = Math.max(1, Math.floor(Number(width || 0)) * Math.floor(Number(height || 0)));
  const frames = Math.max(1, Math.floor(Number(frameCount || 0)));
  const estimatedFrameBytes = Math.ceil(pixelCount * VIDEO_DISK_ESTIMATE_FACTORS.frameBytesPerPixel);
  const estimatedMaskBytes = Math.ceil(
    pixelCount * (hasMask ? VIDEO_DISK_ESTIMATE_FACTORS.maskBytesPerPixel : 0)
  );
  const estimatedResultBytes = Math.ceil(
    pixelCount * VIDEO_DISK_ESTIMATE_FACTORS.resultBytesPerPixel
  );
  const estimatedSegmentBytes = Math.ceil(
    pixelCount * VIDEO_DISK_ESTIMATE_FACTORS.segmentBytesPerPixel
  );
  const estimatedSamMaskBytes = hasSamAssets
    ? Math.ceil(pixelCount * VIDEO_DISK_ESTIMATE_FACTORS.samMaskBytesPerPixel)
    : 0;
  const sourceCopyBytes = Math.ceil(
    Math.max(0, Number(sourceSize || 0)) * VIDEO_DISK_ESTIMATE_FACTORS.sourceCopyMultiplier
  );

  const totalBytes =
    sourceCopyBytes +
    frames * (estimatedFrameBytes + estimatedMaskBytes + estimatedResultBytes + estimatedSegmentBytes) +
    estimatedSamMaskBytes * Math.max(1, frameCount);

  return {
    targetPath: outputDir || tempBase || "",
    requiredBytes: totalBytes,
    safetyBytes: DISK_SPACE_SAFETY_BYTES,
    operation: "视频处理",
    breakdown: {
      sourceCopyBytes,
      estimatedFrameBytes,
      estimatedMaskBytes,
      estimatedResultBytes,
      estimatedSegmentBytes,
      estimatedSamMaskBytes,
    },
  };
};

const ensureVideoDiskSpace = async (estimate) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    return true;
  }
  const result = await window.electron.ipcRenderer.invoke("ensure-disk-space", estimate);
  if (!result?.success) {
    throw new Error(result?.error || "磁盘空间不足，无法继续处理。");
  }
  return result;
};

const sumFileSizes = async (filePaths = []) => {
  if (!window.electron?.ipcRenderer?.invoke || !Array.isArray(filePaths) || filePaths.length === 0) {
    return 0;
  }
  const result = await window.electron.ipcRenderer.invoke("get-files-stats", filePaths);
  if (!result?.success || !Array.isArray(result.data)) {
    return 0;
  }
  return result.data.reduce(
    (total, item) => total + (item?.success ? Number(item.data?.size || item.size || 0) : 0),
    0
  );
};

const ensureVideoProcessingDiskSpace = async ({
  sourcePath,
  tempBase,
  taskRoot,
  framesDir,
  masksDir,
  resultsDir,
  segmentsDir,
  hasMask = false,
  hasSamAssets = false,
  frameCount = 0,
} = {}) => {
  const sourceStats = await window.electron.ipcRenderer.invoke("get-file-stats", sourcePath);
  const sourceSize = Number(sourceStats?.data?.size || 0);
  const estimate = estimateVideoDiskUsage({
    sourceSize,
    frameCount,
    width: videoStore.videoWidth,
    height: videoStore.videoHeight,
    hasMask,
    hasSamAssets,
    outputDir: taskRoot || resultsDir || segmentsDir,
    tempBase,
  });
  await ensureVideoDiskSpace(estimate);

  const rootChecks = [taskRoot, framesDir, masksDir, resultsDir, segmentsDir]
    .filter(Boolean)
    .map((dirPath) =>
      window.electron.ipcRenderer.invoke("ensure-disk-space", {
        targetPath: dirPath,
        requiredBytes: Math.max(
          1,
          Math.ceil(
            (videoStore.videoWidth || 1) *
              (videoStore.videoHeight || 1) *
              Math.max(1, Math.ceil(frameCount || 1)) *
              0.18
          )
        ),
        safetyBytes: DISK_SPACE_SAFETY_BYTES,
        operation: "视频处理临时文件",
      })
    );
  const results = await Promise.all(rootChecks);
  const firstFailure = results.find((item) => !item?.success);
  if (firstFailure) {
    throw new Error(firstFailure.error || "磁盘空间不足，无法继续处理。");
  }
};

const buildOutputVideoPath = async (sourceFile, sourcePath, options = {}) => {
  const outputDir = getOutputDirectory(sourcePath);
  await window.electron.ipcRenderer.invoke("ensure-directory", outputDir);

  const suffix = options.previewTrialSeconds
    ? `preview_${Math.max(1, Math.round(Number(options.previewTrialSeconds)))}s`
    : "processed";
  const outputName = `${sourceFile.name.replace(/\.[^/.]+$/, "")}_${suffix}_${Date.now()}.mp4`;
  return window.electron.ipcRenderer.joinPath(outputDir, outputName);
};

const getTaskDirectoryName = (taskRoot) => String(taskRoot || "").split(/[\\/]/).pop() || "";

const findFallbackResumeTaskInTempBase = async ({ fingerprint, tempBase }) => {
  if (!fingerprint || !tempBase || !window.electron?.ipcRenderer?.readdir) {
    return null;
  }

  let directoryEntries = [];
  try {
    directoryEntries = await window.electron.ipcRenderer.readdir(tempBase);
  } catch {
    return null;
  }

  let latestTask = null;
  for (const entryName of directoryEntries) {
    if (!String(entryName || "").startsWith(VIDEO_TASK_DIRECTORY_PREFIX)) {
      continue;
    }

    const taskRoot = joinRendererPath(tempBase, entryName);
    const taskMeta = await readVideoTaskMetaFromRoot(taskRoot);
    if (!taskMeta) {
      continue;
    }
    if (taskMeta.previewTrial === true) {
      continue;
    }
    if (taskMeta.fingerprint !== fingerprint || !isResumableVideoTaskStatus(taskMeta.status)) {
      continue;
    }

    if (!latestTask || latestTask.updatedAt <= taskMeta.updatedAt) {
      latestTask = taskMeta;
    }
  }

  return latestTask;
};

const findLatestResumableVideoTask = async ({ fingerprint, tempBase }) => {
  const registry = await readVideoProcessingRegistry();
  const summary = findLatestResumableTaskSummary(registry, fingerprint);

  if (summary?.taskRoot) {
    const taskMeta = await readVideoTaskMetaFromRoot(summary.taskRoot);
    if (
      taskMeta &&
      taskMeta.fingerprint === fingerprint &&
      isResumableVideoTaskStatus(taskMeta.status)
    ) {
      return taskMeta;
    }

    if (summary.taskId) {
      await removeVideoTaskFromRegistry(summary.taskId);
    }
  }

  const fallbackTask = await findFallbackResumeTaskInTempBase({ fingerprint, tempBase });
  if (fallbackTask) {
    await persistVideoTaskMeta(fallbackTask);
  }
  return fallbackTask;
};

const getValidatedCompletedSegments = async (taskMeta) => {
  const contiguousSegments = [];
  const segments = normalizeVideoTaskMeta(taskMeta).completedSegments;

  for (const segment of segments) {
    if (segment.segmentIndex !== contiguousSegments.length + 1) {
      break;
    }

    const stats = await window.electron.ipcRenderer.invoke("get-file-stats", segment.path);
    if (!stats?.success || !(Number(stats?.data?.size || 0) > 0)) {
      break;
    }

    contiguousSegments.push(segment);
  }

  return contiguousSegments;
};

const promptResumeVideoTaskDecision = async ({ taskMeta, hasConfigMismatch }) =>
  new Promise((resolve) => {
    const completedSegmentCount = taskMeta.completedSegments.length;
    const segmentLabel =
      completedSegmentCount > 0
        ? `已生成 ${completedSegmentCount} 个分段视频。`
        : "上次任务尚未生成可复用的分段视频。";
    const configHint = hasConfigMismatch
      ? "\n检测到当前界面配置与上次失败任务不一致，继续处理时将沿用旧 segments，并使用当前配置生成后续段落。"
      : "";

    $q.dialog({
      title: "发现上次未完成的视频处理任务",
      message: `${segmentLabel}\n是否从最近一次失败断点继续处理？${configHint}`,
      ok: {
        label: "继续处理",
        color: "primary",
        unelevated: true,
      },
      cancel: {
        label: "重新处理",
        color: "negative",
        flat: true,
      },
      persistent: true,
    })
      .onOk(() => resolve("resume"))
      .onCancel(() => resolve("restart"))
      .onDismiss(() => resolve(null));
  });

async function discardLatestResumableTaskForSourcePath({
  sourcePath,
  nextSourcePath = "",
} = {}) {
  if (!sourcePath || !window.electron?.ipcRenderer?.invoke) {
    return;
  }

  let sourceFingerprint = null;
  try {
    sourceFingerprint = await computeVideoFileFingerprint(sourcePath);
  } catch {
    return;
  }

  if (nextSourcePath) {
    try {
      const nextFingerprint = await computeVideoFileFingerprint(nextSourcePath);
      if (nextFingerprint.fingerprint === sourceFingerprint.fingerprint) {
        return;
      }
    } catch {
      // If the next source cannot be fingerprinted yet, fall back to cleaning the old task.
    }
  }

  const taskMeta = await findLatestResumableVideoTask({
    fingerprint: sourceFingerprint.fingerprint,
    tempBase: resolveConfiguredTempBase(sourcePath),
  });

  if (!taskMeta) {
    return;
  }

  await discardVideoTask(taskMeta);
}

const discardVideoTasksBySourcePath = async (sourcePath) => {
  if (!sourcePath) {
    return;
  }

  const registry = await readVideoProcessingRegistry();
  const tasks = Object.values(registry.tasks || {}).filter(
    (task) => String(task?.sourcePath || "") === String(sourcePath || "")
  );

  for (const task of tasks) {
    const taskMeta = await readVideoTaskMetaFromRoot(task.taskRoot);
    if (taskMeta?.taskId) {
      await discardVideoTask(taskMeta, {
        preserveTemporarySourcePath: "",
      });
    } else if (task?.taskId) {
      await removeVideoTaskFromRegistry(task.taskId);
    }
  }
};

const estimateRemainingBatchCount = ({
  totalFrames,
  startFrame,
  batchSize,
}) => {
  const remainingFrames = Math.max(0, Math.round(Number(totalFrames || 0) - Number(startFrame || 0)));
  if (!(remainingFrames > 0)) {
    return 0;
  }
  return Math.max(1, Math.ceil(remainingFrames / Math.max(1, Number(batchSize || 1))));
};

const buildCompletedSegmentEntry = ({
  segmentIndex,
  start,
  end,
  path,
}) => ({
  segmentIndex: Math.max(1, Math.round(Number(segmentIndex || 1))),
  start: Math.max(0, Math.round(Number(start || 0))),
  end: Math.max(0, Math.round(Number(end || 0))),
  path: String(path || ""),
  fileName: String(path || "").split(/[\\/]/).pop() || "",
  completedAt: Date.now(),
});

const normalizeProcessingPhase = (phase = processingPhase.value) => {
  const resolvedPhase = String(phase || "");
  if (Object.values(VIDEO_PROCESSING_PHASES).includes(resolvedPhase)) {
    return resolvedPhase;
  }
  const currentPhase = String(processingPhase.value || "");
  return Object.values(VIDEO_PROCESSING_PHASES).includes(currentPhase)
    ? currentPhase
    : VIDEO_PROCESSING_PHASES.IDLE;
};

const formatStageProgressText = (stageProgress = null) => {
  const numericProgress = Number(stageProgress);
  if (!Number.isFinite(numericProgress)) return "";
  const percent = Math.max(0, Math.min(100, Math.round(numericProgress * 100)));
  return `，当前阶段 ${percent}%`;
};

const appendStageProgressToMessage = (message = "", stageProgress = null) => {
  const normalizedMessage = String(message || "");
  if (/当前阶段\s*\d+%/.test(normalizedMessage)) return normalizedMessage;
  return `${normalizedMessage}${formatStageProgressText(stageProgress)}`;
};

const withBackendProgressHint = (
  message = "",
  phase = processingPhase.value
) => {
  const normalizedMessage = String(message || "");
  const normalizedPhase = normalizeProcessingPhase(phase);
  if (
    normalizedPhase === VIDEO_PROCESSING_PHASES.COMPLETE ||
    normalizedMessage.startsWith("处理完成") ||
    normalizedMessage.startsWith("样片试跑完成")
  ) {
    return "可点击打开目录查看视频文件";
  }
  return normalizedPhase === VIDEO_PROCESSING_PHASES.BACKEND && backendRunningState?.value
    ? `${normalizedMessage}\n可打开后端管理页面查看进度`
    : normalizedMessage;
};

const updateGlobalLoadingOverlay = (message, progress = null) => {
  if (loadingControl?.update) {
    loadingControl.update({
      message,
      progress: typeof progress === "number" ? progress : null,
    });
  } else if (loadingControl?.show) {
    loadingControl.show({
      message,
      progress: typeof progress === "number" ? progress : null,
    });
  }
};

const updateSamVideoGlobalLoadingOverlay = (message, progress = null) => {
  const normalizedProgress =
    typeof progress === "number" ? Math.max(0, Math.min(1, progress)) : null;
  const percentText =
    typeof normalizedProgress === "number" ? `（${Math.round(normalizedProgress * 100)}%）` : "";
  const payload = {
    message: `${message}${percentText}\n可打开后端管理页面查看进度`,
    progress: normalizedProgress,
    actionLabel: "打开后端管理",
    onAction: () => backendEngineValue.value.openDiagnostics(),
  };
  if (loadingControl?.update) {
    loadingControl.update(payload);
  } else if (loadingControl?.show) {
    loadingControl.show(payload);
  }
};

const hideGlobalLoadingOverlay = () => {
  loadingControl?.hide?.();
};

const normalizeProcessingProgress = (progress = processingProgress.value) =>
  Math.max(0, Math.min(1, Number(progress || 0)));

const setProcessingUiState = (
  message,
  progress = processingProgress.value,
  phase = processingPhase.value,
  stageProgress = null
) => {
  const normalizedPhase = normalizeProcessingPhase(phase);
  processingPhase.value = normalizedPhase;
  const resolvedMessage = withBackendProgressHint(
    appendStageProgressToMessage(message, stageProgress),
    normalizedPhase
  );
  processingMessage.value = resolvedMessage;
  processingProgress.value = normalizeProcessingProgress(progress);
  return resolvedMessage;
};

const applyProcessingUi = (
  message,
  progress = processingProgress.value,
  phase = processingPhase.value,
  stageProgress = null
) => {
  const resolvedMessage = setProcessingUiState(message, progress, phase, stageProgress);
  updateGlobalLoadingOverlay(resolvedMessage, processingProgress.value);
};

const updateProcessingUiWithoutOverlay = (
  message,
  progress = processingProgress.value,
  phase = processingPhase.value,
  stageProgress = null
) => {
  clearProcessingBatchMessageContext();
  setProcessingUiState(message, progress, phase, stageProgress);
};

const flushProcessingUiFrame = async () => {
  await nextTick();
  if (typeof window !== "undefined" && typeof window.requestAnimationFrame === "function") {
    await new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
};

const clearProcessingEtaTicker = () => {
  if (processingEtaTickerId === null) return;
  window.clearInterval(processingEtaTickerId);
  processingEtaTickerId = null;
};

const clearProgressAwareEtaState = () => {
  processingEtaState.progressAwareCapSeconds = null;
  processingEtaState.progressAwareFloorSeconds = null;
  processingEtaState.progressAwareStageBaseSeconds = null;
};

const clearProcessingBatchMessageContext = () => {
  processingBatchMessageContext = null;
  processingEtaState.estimateBaseSeconds = null;
  processingEtaState.estimateFloorSeconds = 0;
  processingEtaState.estimateStartedAtMs = 0;
  processingEtaState.frozenSeconds = null;
  clearProgressAwareEtaState();
  clearProcessingEtaTicker();
};

const resetProcessingEtaState = () => {
  clearProcessingBatchMessageContext();
  processingEtaState.firstResponseSeconds = null;
  processingEtaState.sessionStartedAtMs = 0;
};

const createSkippedVideoBatchResponse = (batch) => ({
  model_id: currentModel.value,
  processed_count: batch.batchFrameCount,
  success_count: batch.batchFrameCount,
  failed_count: 0,
  batch_time: 0,
  failure_snapshot_dir: null,
  results: batch.batchResultPaths.map((outputPath, index) => ({
    frame_index: batch.start + index,
    output_path: outputPath,
    success: true,
    skipped: true,
    skip_reason: "outside-processing-range",
  })),
});

const formatEta = (seconds) => {
  const safeSeconds = Math.max(0, Math.round(Number(seconds || 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const secs = safeSeconds % 60;

  if (hours > 0) {
    return `${hours}h${String(minutes).padStart(2, "0")}m${String(secs).padStart(2, "0")}s`;
  }
  if (minutes > 0) {
    return `${minutes}m${String(secs).padStart(2, "0")}s`;
  }
  return `${secs}s`;
};

const getAverageBatchSeconds = (
  batchDurations = [],
  fallbackSeconds = processingEtaState.firstResponseSeconds
) => {
  if (batchDurations.length > 0) {
    const recentSamples = batchDurations.slice(-6);
    const totalWeight = recentSamples.reduce((sum, _value, index) => sum + index + 1, 0);
    const weightedSum = recentSamples.reduce(
      (sum, value, index) => sum + Number(value || 0) * (index + 1),
      0
    );
    return totalWeight > 0 ? weightedSum / totalWeight : Number(fallbackSeconds || 0);
  }
  return Number(fallbackSeconds || 0);
};

const getProgressBasedEtaSeconds = (progress = processingProgress.value) => {
  if (!(processingEtaState.sessionStartedAtMs > 0)) return null;

  const clampedProgress = Math.max(0, Math.min(0.97, Number(progress || 0)));
  if (!(clampedProgress >= 0.05)) return null;

  const elapsedSeconds = Math.max(
    0,
    (performance.now() - processingEtaState.sessionStartedAtMs) / 1000
  );
  if (!(elapsedSeconds > 1)) return null;

  return Math.max(0, elapsedSeconds * ((1 - clampedProgress) / clampedProgress));
};

const blendProcessingEtaSeconds = ({
  batchModelSeconds,
  progressModelSeconds = null,
  progress = processingProgress.value,
  completedBatchCount = 0,
}) => {
  if (!(progressModelSeconds > 0)) {
    return batchModelSeconds;
  }

  const progressWeight = Math.min(
    0.7,
    Math.max(0, completedBatchCount - 1) * 0.12 + Math.max(0, Number(progress || 0) - 0.12) * 0.45
  );
  if (!(progressWeight > 0)) {
    return batchModelSeconds;
  }

  return batchModelSeconds * (1 - progressWeight) + progressModelSeconds * progressWeight;
};

const getRemainingBatchCount = ({
  batchNumber,
  totalBatches,
  remainingBatchCount = null,
}) => {
  if (
    remainingBatchCount !== null &&
    remainingBatchCount !== undefined &&
    Number.isFinite(Number(remainingBatchCount))
  ) {
    return Math.max(0, Number(remainingBatchCount));
  }
  return Math.max(0, totalBatches - batchNumber + 1);
};

const getActiveStageRemainingBatchCount = ({ batchNumber, totalBatches }) =>
  Math.max(0, totalBatches - batchNumber + 1);

const resolveProcessingEtaSnapshot = ({
  batchNumber,
  totalBatches,
  batchDurations = [],
  pipelineBatchDurations = [],
  remainingBatchCount = null,
  progress = processingProgress.value,
}) => {
  const averageProcessingBatchSeconds = getAverageBatchSeconds(batchDurations);
  const averagePipelineBatchSeconds = getAverageBatchSeconds(
    pipelineBatchDurations,
    averageProcessingBatchSeconds
  );
  if (
    !(averageProcessingBatchSeconds > 0) ||
    !(averagePipelineBatchSeconds > 0) ||
    !(processingEtaState.firstResponseSeconds > 0)
  ) {
    return null;
  }

  const nextRemainingBatchCount = getRemainingBatchCount({
    batchNumber,
    totalBatches,
    remainingBatchCount,
  });
  const remainingBatchCountWithActive = getActiveStageRemainingBatchCount({
    batchNumber,
    totalBatches,
  });
  const includesCurrentBatch = nextRemainingBatchCount >= remainingBatchCountWithActive;
  const currentBatchBudgetSeconds = includesCurrentBatch
    ? Math.max(1, averageProcessingBatchSeconds)
    : 0;
  const futureBatchCount = includesCurrentBatch
    ? Math.max(0, nextRemainingBatchCount - 1)
    : nextRemainingBatchCount;
  const futureBatchSeconds =
    averagePipelineBatchSeconds * futureBatchCount +
    PROCESSING_FINAL_STAGE_PLACEHOLDER_SECONDS;
  const batchModelSeconds =
    Math.max(currentBatchBudgetSeconds, processingEtaState.firstResponseSeconds) +
    futureBatchSeconds;
  const progressModelSeconds = getProgressBasedEtaSeconds(progress);
  const baseSeconds = Math.max(
    futureBatchSeconds + currentBatchBudgetSeconds,
    blendProcessingEtaSeconds({
      batchModelSeconds,
      progressModelSeconds,
      progress,
      completedBatchCount: pipelineBatchDurations.length,
    })
  );
  const floorSeconds =
    !includesCurrentBatch
      ? Math.max(1, futureBatchSeconds)
      : nextRemainingBatchCount <= 1
      ? 1
      : Math.max(futureBatchSeconds, baseSeconds - processingEtaState.firstResponseSeconds);

  return {
    averageProcessingBatchSeconds,
    averagePipelineBatchSeconds,
    nextRemainingBatchCount,
    includesCurrentBatch,
    currentBatchBudgetSeconds,
    futureBatchCount,
    futureBatchSeconds,
    baseSeconds,
    floorSeconds,
  };
};

const primeProcessingEta = ({
  batchNumber,
  totalBatches,
  batchDurations = [],
  pipelineBatchDurations = [],
  remainingBatchCount = null,
  progress = processingProgress.value,
}) => {
  const snapshot = resolveProcessingEtaSnapshot({
    batchNumber,
    totalBatches,
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount,
    progress,
  });
  if (!snapshot) {
    processingEtaState.estimateBaseSeconds = null;
    processingEtaState.estimateFloorSeconds = 0;
    processingEtaState.estimateStartedAtMs = 0;
    clearProgressAwareEtaState();
    return null;
  }

  processingEtaState.estimateBaseSeconds = snapshot.baseSeconds;
  processingEtaState.estimateFloorSeconds = snapshot.floorSeconds;
  processingEtaState.estimateStartedAtMs = performance.now();
  clearProgressAwareEtaState();
  return snapshot.baseSeconds;
};

const freezeProcessingEtaAtCurrentValue = () => {
  const etaSeconds = getCurrentProcessingEtaSeconds();
  processingEtaState.frozenSeconds =
    etaSeconds === null ? null : Math.max(0, Number(etaSeconds || 0));
  clearProcessingEtaTicker();
  return processingEtaState.frozenSeconds;
};

const primeProgressAwareEta = ({
  batchNumber,
  totalBatches,
  batchDurations = [],
  pipelineBatchDurations = [],
  remainingBatchCount = null,
  overallProgress = processingProgress.value,
  stageProgress = 0,
  initialEtaSeconds = null,
  resetStageBase = false,
}) => {
  const snapshot = resolveProcessingEtaSnapshot({
    batchNumber,
    totalBatches,
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount,
    progress: overallProgress,
  });
  if (!snapshot) {
    processingEtaState.estimateBaseSeconds = null;
    processingEtaState.estimateFloorSeconds = 0;
    processingEtaState.estimateStartedAtMs = 0;
    clearProgressAwareEtaState();
    return null;
  }

  const shouldResetStageBase =
    resetStageBase || !(processingEtaState.progressAwareStageBaseSeconds > 0);
  const fallbackBaseSeconds =
    initialEtaSeconds ?? processingEtaState.estimateBaseSeconds ?? snapshot.baseSeconds;
  const minimumStageBaseSeconds =
    snapshot.futureBatchSeconds + snapshot.currentBatchBudgetSeconds;
  const nextStageBaseSeconds = shouldResetStageBase
    ? Math.max(minimumStageBaseSeconds, fallbackBaseSeconds)
    : Math.max(processingEtaState.progressAwareStageBaseSeconds, minimumStageBaseSeconds);
  const clampedProgress = Math.max(0, Math.min(1, Number(stageProgress || 0)));

  if (shouldResetStageBase) {
    processingEtaState.progressAwareStageBaseSeconds = nextStageBaseSeconds;
    processingEtaState.estimateBaseSeconds = nextStageBaseSeconds;
    processingEtaState.estimateFloorSeconds = snapshot.futureBatchSeconds;
    processingEtaState.estimateStartedAtMs = performance.now();
  }

  const stageBaseSeconds = Math.max(
    processingEtaState.progressAwareStageBaseSeconds,
    snapshot.futureBatchSeconds
  );
  const stageBudgetSeconds = Math.max(0.25, stageBaseSeconds - snapshot.futureBatchSeconds);
  processingEtaState.progressAwareFloorSeconds = snapshot.futureBatchSeconds;
  processingEtaState.progressAwareCapSeconds = Math.max(
    snapshot.futureBatchSeconds,
    snapshot.futureBatchSeconds + stageBudgetSeconds * (1 - clampedProgress)
  );
  return processingEtaState.progressAwareCapSeconds;
};

const getCurrentProcessingEtaSeconds = () => {
  if (
    typeof processingEtaState.frozenSeconds === "number" &&
    Number.isFinite(processingEtaState.frozenSeconds)
  ) {
    return Math.max(0, processingEtaState.frozenSeconds);
  }
  const hasEstimateBase = processingEtaState.estimateBaseSeconds > 0;
  const elapsedBasedEtaSeconds = hasEstimateBase
    ? Math.max(
        processingEtaState.estimateFloorSeconds,
        processingEtaState.estimateBaseSeconds -
          Math.max(0, (performance.now() - processingEtaState.estimateStartedAtMs) / 1000)
      )
    : null;

  if (
    typeof processingEtaState.progressAwareCapSeconds === "number" &&
    Number.isFinite(processingEtaState.progressAwareCapSeconds)
  ) {
    if (elapsedBasedEtaSeconds === null) {
      return Math.max(0, processingEtaState.progressAwareCapSeconds);
    }

    return Math.max(
      processingEtaState.progressAwareFloorSeconds ?? processingEtaState.estimateFloorSeconds,
      Math.min(elapsedBasedEtaSeconds, processingEtaState.progressAwareCapSeconds)
    );
  }

  return elapsedBasedEtaSeconds;
};

const buildBatchMessage = ({
  batchNumber,
  totalBatches,
  stageLabel,
  etaProgress = null,
}) => {
  const baseMessage = `正在处理第 ${batchNumber}/${totalBatches} 批：${stageLabel}${formatStageProgressText(etaProgress)}`;
  const etaSeconds = getCurrentProcessingEtaSeconds();
  if (etaSeconds === null) return baseMessage;
  return `${baseMessage}，预计剩余 ${formatEta(etaSeconds)}`;
};

const refreshProcessingBatchMessage = () => {
  if (!processingBatchMessageContext) return;
  applyProcessingUi(
    buildBatchMessage(processingBatchMessageContext),
    processingProgress.value,
    processingBatchMessageContext.phase
  );
};

const ensureProcessingEtaTicker = () => {
  if (processingEtaTickerId !== null) return;
  processingEtaTickerId = window.setInterval(() => {
    refreshProcessingBatchMessage();
  }, PROCESSING_ETA_TICK_MS);
};

const updateBatchProcessingUi = ({
  batchNumber,
  totalBatches,
  stageLabel,
  batchDurations = [],
  pipelineBatchDurations = [],
  progress = processingProgress.value,
  remainingBatchCount = null,
  etaMode = PROCESSING_ETA_MODES.DYNAMIC,
  etaProgress = null,
  phase = processingPhase.value,
}) => {
  const previousBatchMessageContext = processingBatchMessageContext;
  const previousEtaSeconds = getCurrentProcessingEtaSeconds();
  const shouldFreezeEta = etaMode === PROCESSING_ETA_MODES.FREEZE;
  const resolvedRemainingBatchCount = getRemainingBatchCount({
    batchNumber,
    totalBatches,
    remainingBatchCount,
  });
  const normalizedEtaProgress = Number.isFinite(Number(etaProgress))
    ? Math.max(0, Math.min(1, Number(etaProgress)))
    : null;
  const shouldUseProgressAwareEta =
    !shouldFreezeEta && normalizedEtaProgress !== null;
  const isSameFrozenStage =
    shouldFreezeEta &&
    previousBatchMessageContext?.etaMode === PROCESSING_ETA_MODES.FREEZE &&
    previousBatchMessageContext?.batchNumber === batchNumber &&
    previousBatchMessageContext?.stageLabel === stageLabel;
  const shouldPrimeDynamicEta =
    !shouldFreezeEta &&
    (
      previousBatchMessageContext?.etaMode !== PROCESSING_ETA_MODES.DYNAMIC ||
      previousBatchMessageContext?.batchNumber !== batchNumber ||
      previousBatchMessageContext?.totalBatches !== totalBatches ||
      previousBatchMessageContext?.stageLabel !== stageLabel ||
      previousBatchMessageContext?.remainingBatchCount !== resolvedRemainingBatchCount ||
      processingEtaState.estimateBaseSeconds === null
    );

  processingBatchMessageContext = {
    batchNumber,
    totalBatches,
    stageLabel,
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount: resolvedRemainingBatchCount,
    etaMode,
    progress,
    etaProgress: normalizedEtaProgress,
    phase: normalizeProcessingPhase(phase),
  };

  if (shouldFreezeEta) {
    if (!isSameFrozenStage) {
      freezeProcessingEtaAtCurrentValue();
    } else {
      clearProcessingEtaTicker();
    }
    clearProgressAwareEtaState();
  } else {
    processingEtaState.frozenSeconds = null;
    if (shouldUseProgressAwareEta) {
      primeProgressAwareEta({
        batchNumber,
        totalBatches,
        batchDurations,
        pipelineBatchDurations,
        remainingBatchCount,
        overallProgress: progress,
        stageProgress: normalizedEtaProgress,
        initialEtaSeconds: previousEtaSeconds,
        resetStageBase: shouldPrimeDynamicEta,
      });
    } else {
      clearProgressAwareEtaState();
    }

    if (shouldPrimeDynamicEta && !shouldUseProgressAwareEta) {
      primeProcessingEta({
        batchNumber,
        totalBatches,
        batchDurations,
        pipelineBatchDurations,
        remainingBatchCount,
        progress,
      });
    }

    if (processingEtaState.estimateBaseSeconds !== null) {
      ensureProcessingEtaTicker();
    } else {
      clearProcessingEtaTicker();
    }
  }

  applyProcessingUi(
    buildBatchMessage(processingBatchMessageContext),
    progress,
    processingBatchMessageContext.phase
  );
};

const refreshProcessingEtaEstimate = () => {
  if (!processingBatchMessageContext) return;
  if (processingBatchMessageContext.etaMode === PROCESSING_ETA_MODES.FREEZE) {
    refreshProcessingBatchMessage();
    return;
  }

  primeProcessingEta(processingBatchMessageContext);
  if (processingEtaState.estimateBaseSeconds !== null) {
    ensureProcessingEtaTicker();
  }
  refreshProcessingBatchMessage();
};

const updateProcessingUi = (
  message,
  progress = processingProgress.value,
  phase = processingPhase.value,
  stageProgress = null
) => {
  clearProcessingBatchMessageContext();
  applyProcessingUi(message, progress, phase, stageProgress);
};

const formatProcessingStageError = (stageLabel, error) => {
  const detail = error?.message ? String(error.message) : String(error || "");
  return detail ? `${stageLabel}失败: ${detail}` : `${stageLabel}失败`;
};

let videoProcessingFallbackNotified = false;

const getConfiguredVideoProcessingEngine = () => {
  const mode = String(configStore.config.advanced?.videoProcessingEngine || "auto").toLowerCase();
  return ["auto", "webav", "ffmpeg"].includes(mode) ? mode : "auto";
};

const invokeVideoFfmpegIpc = async (channel, payload = {}) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    throw new Error("当前环境无法调用 FFmpeg");
  }

  const result = await window.electron.ipcRenderer.invoke(channel, payload);
  if (!result?.success) {
    throw new Error(result?.error || `FFmpeg 操作失败: ${channel}`);
  }
  return result;
};

const notifyVideoFfmpegFallback = (stageLabel, error) => {
  console.warn(`${stageLabel} WebAV failed, falling back to FFmpeg:`, error);
  if (videoProcessingFallbackNotified) {
    return;
  }

  videoProcessingFallbackNotified = true;
  $q.notify({
    type: "warning",
    message: `${stageLabel} WebAV 失败，已切换 FFmpeg 兜底导出`,
    position: "top",
    timeout: 4200,
  });
};

const runWithVideoProcessingEngine = async ({ stageLabel, webav, ffmpeg }) => {
  const engine = getConfiguredVideoProcessingEngine();
  if (engine === "ffmpeg") {
    return await ffmpeg();
  }
  if (engine === "webav") {
    return await webav();
  }

  try {
    return await webav();
  } catch (error) {
    notifyVideoFfmpegFallback(stageLabel, error);
    updateProcessingUi(`${stageLabel} WebAV 失败，正在切换 FFmpeg 兜底`, processingProgress.value);
    await flushProcessingUiFrame();
    return await ffmpeg();
  }
};

const ensureMp4ExportSupported = async (width, height) => {
  if (mp4ExportSupportChecked) return;

  const supported = await Combinator.isSupported({
    width,
    height,
    bitrate: 5_000_000,
    videoCodec: "avc1.42E032",
  });
  if (!supported) {
    throw new Error("当前环境不支持 WebAV MP4 导出");
  }
  mp4ExportSupportChecked = true;
};

const removeTemporaryFiles = async (filePaths = []) => {
  await Promise.allSettled(
    filePaths
      .filter(Boolean)
      .map((filePath) => window.electron.ipcRenderer.invoke("cleanup-temp-file", filePath))
  );
};

const openPathAsStream = async (filePath) => {
  const response = await fetchLocalFileResponse(filePath);
  if (response.body) {
    return response.body;
  }

  const bytes = await response.arrayBuffer();
  return new Blob([bytes], { type: getMimeTypeForPath(filePath) }).stream();
};

const saveStreamToPath = async (stream, outputPath, options = {}) => {
  if (!window.electron?.ipcRenderer?.invoke) {
    throw new Error("当前环境无法写入本地文件");
  }

  const openResult = await window.electron.ipcRenderer.invoke(
    "open-file-write-stream",
    {
      filePath: outputPath,
      estimatedBytes: options.estimatedBytes || 0,
      safetyBytes: options.safetyBytes || DISK_SPACE_SAFETY_BYTES,
      operation: options.operation || "写入视频文件",
    }
  );
  if (!openResult?.success || !openResult.streamId) {
    throw new Error(openResult?.error || `无法创建输出文件: ${outputPath}`);
  }

  const reader = stream.getReader();
  let streamClosed = false;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength <= 0) continue;

      const writeResult = await window.electron.ipcRenderer.invoke(
        "write-file-stream-chunk",
        {
          streamId: openResult.streamId,
          chunk: value,
        }
      );
      if (!writeResult?.success) {
        throw new Error(writeResult?.error || `写入输出文件失败: ${outputPath}`);
      }
    }

    const closeResult = await window.electron.ipcRenderer.invoke(
      "close-file-write-stream",
      openResult.streamId
    );
    streamClosed = Boolean(closeResult?.success);
    if (!closeResult?.success) {
      throw new Error(closeResult?.error || `完成输出文件写入失败: ${outputPath}`);
    }

    return closeResult.filePath || openResult.filePath || outputPath;
  } catch (error) {
    if (!streamClosed) {
      await window.electron.ipcRenderer
        .invoke("abort-file-write-stream", openResult.streamId)
        .catch(() => undefined);
    }
    throw error;
  } finally {
    reader.releaseLock?.();
  }
};

const getDirectoryPath = (filePath) => String(filePath || "").replace(/[\\/][^\\/]+$/, "");

const buildIntermediateConcatPath = ({ segmentDirectory, roundIndex, groupIndex }) =>
  joinRendererPath(
    segmentDirectory,
    `concat_round_${String(roundIndex).padStart(2, "0")}_${String(groupIndex + 1).padStart(4, "0")}.mp4`
  );

const getConcatOperationCount = (segmentCount, groupSize = FINAL_CONCAT_GROUP_SIZE) => {
  let pendingCount = Math.max(0, Math.floor(Number(segmentCount || 0)));
  let operationCount = 0;

  while (pendingCount > groupSize) {
    let nextPendingCount = 0;
    for (let start = 0; start < pendingCount; start += groupSize) {
      const currentGroupSize = Math.min(groupSize, pendingCount - start);
      if (currentGroupSize > 1) {
        operationCount += 1;
      }
      nextPendingCount += 1;
    }
    pendingCount = nextPendingCount;
  }

  if (pendingCount > 1) {
    operationCount += 1;
  }

  return operationCount;
};

const concatSegmentGroupToPath = async ({ segmentPaths, outputPath }) => {
  if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) {
    throw new Error("没有可用于拼接的视频分段");
  }
  if (segmentPaths.length === 1) {
    return segmentPaths[0];
  }

  const estimatedBytes = await sumFileSizes(segmentPaths);
  const streams = await Promise.all(segmentPaths.map((segmentPath) => openPathAsStream(segmentPath)));
  const mergedStream = await fastConcatMP4(streams);
  return await saveStreamToPath(mergedStream, outputPath, {
    estimatedBytes,
    operation: "拼接视频分段",
  });
};

const concatSegmentPathsInLayers = async ({
  segmentPaths,
  finalOutputPath = "",
  reserveProgressForAudio = false,
}) => {
  if (!Array.isArray(segmentPaths) || segmentPaths.length === 0) {
    throw new Error("没有可用于拼接的视频分段");
  }
  if (segmentPaths.length === 1) {
    return {
      mergedPath: segmentPaths[0],
      intermediatePaths: [],
    };
  }

  const totalOperations = getConcatOperationCount(segmentPaths.length);
  const progressSpan = reserveProgressForAudio
    ? FINAL_CONCAT_WITH_AUDIO_PROGRESS_SPAN
    : FINAL_CONCAT_NO_AUDIO_PROGRESS_SPAN;
  const segmentDirectory = getDirectoryPath(segmentPaths[0]);
  const transientPathSet = new Set();
  const intermediatePaths = [];

  let currentPaths = [...segmentPaths];
  let roundIndex = 1;
  let completedOperations = 0;

  const updateConcatProgress = () => {
    const ratio = totalOperations > 0 ? completedOperations / totalOperations : 1;
    const displayStep = Math.min(completedOperations + 1, totalOperations);
    const progress = FINAL_CONCAT_PROGRESS_BASE + progressSpan * ratio;
    updateProcessingUi(
      `正在拼接视频分段（${displayStep}/${totalOperations}）`,
      progress,
      VIDEO_PROCESSING_PHASES.FINALIZING,
      ratio
    );
  };

  while (currentPaths.length > 1) {
    if (currentPaths.length <= FINAL_CONCAT_GROUP_SIZE) {
      updateConcatProgress();
      const targetPath =
        finalOutputPath ||
        buildIntermediateConcatPath({
          segmentDirectory,
          roundIndex,
          groupIndex: 0,
        });
      const mergedPath = await concatSegmentGroupToPath({
        segmentPaths: currentPaths,
        outputPath: targetPath,
      });
      if (!finalOutputPath) {
        transientPathSet.add(mergedPath);
        intermediatePaths.push(mergedPath);
      }
      completedOperations += 1;

      const obsoletePaths = currentPaths.filter((path) => transientPathSet.has(path));
      if (obsoletePaths.length > 0) {
        await removeTemporaryFiles(obsoletePaths);
        obsoletePaths.forEach((path) => transientPathSet.delete(path));
      }

      return {
        mergedPath,
        intermediatePaths,
      };
    }

    const nextPaths = [];
    for (let start = 0, groupIndex = 0; start < currentPaths.length; start += FINAL_CONCAT_GROUP_SIZE, groupIndex += 1) {
      const groupPaths = currentPaths.slice(start, start + FINAL_CONCAT_GROUP_SIZE);
      if (groupPaths.length === 1) {
        nextPaths.push(groupPaths[0]);
        continue;
      }

      updateConcatProgress();
      const outputPath = buildIntermediateConcatPath({
        segmentDirectory,
        roundIndex,
        groupIndex,
      });
      const mergedPath = await concatSegmentGroupToPath({
        segmentPaths: groupPaths,
        outputPath,
      });

      transientPathSet.add(mergedPath);
      intermediatePaths.push(mergedPath);
      nextPaths.push(mergedPath);
      completedOperations += 1;
    }

    const obsoletePaths = currentPaths.filter((path) => transientPathSet.has(path));
    if (obsoletePaths.length > 0) {
      await removeTemporaryFiles(obsoletePaths);
      obsoletePaths.forEach((path) => transientPathSet.delete(path));
    }

    currentPaths = nextPaths;
    roundIndex += 1;
  }

  return {
    mergedPath: currentPaths[0],
    intermediatePaths,
  };
};

const exportProcessedBatchSegmentWithWebAv = async ({
  framePaths,
  outputPath,
  width,
  height,
  fps,
  progressBase,
  progressWeight,
  batchNumber,
  totalBatches,
  batchDurations,
  pipelineBatchDurations,
}) => {
  await ensureMp4ExportSupported(width, height);
  const missingFramePaths = await getMissingFilePaths(framePaths);
  if (missingFramePaths.length > 0) {
    const preview = missingFramePaths.slice(0, 2).join("；");
    const suffix = missingFramePaths.length > 2 ? " 等文件" : "";
    throw new Error(`当前批次缺少结果帧文件：${preview}${suffix}`);
  }

  const frameClip = new ProcessedFramesClip({ framePaths, width, height, fps });
  const mainSprite = new OffscreenSprite(frameClip);
  const combinator = new Combinator({
    width,
    height,
    fps,
    bitrate: 5_000_000,
    videoCodec: "avc1.42E032",
    audio: false,
  });

  let unbindProgress = null;
  try {
    await combinator.addSprite(mainSprite, { main: true });
    updateBatchProcessingUi({
      batchNumber,
      totalBatches,
      stageLabel: "正在编码临时视频分段",
      batchDurations,
      pipelineBatchDurations,
      remainingBatchCount: getActiveStageRemainingBatchCount({ batchNumber, totalBatches }),
      progress: progressBase,
      etaProgress: 0,
      phase: VIDEO_PROCESSING_PHASES.ENCODING,
    });
    await flushProcessingUiFrame();
    unbindProgress = combinator.on("OutputProgress", (progress) => {
      const normalized = Math.max(0, Math.min(1, progress));
      updateBatchProcessingUi({
        batchNumber,
        totalBatches,
        stageLabel: "正在编码临时视频分段",
        batchDurations,
        pipelineBatchDurations,
        remainingBatchCount: getActiveStageRemainingBatchCount({ batchNumber, totalBatches }),
        progress: progressBase + progressWeight * normalized,
        etaProgress: normalized,
        phase: VIDEO_PROCESSING_PHASES.ENCODING,
      });
    });

    const stream = combinator.output();
    return await saveStreamToPath(stream, outputPath, {
      estimatedBytes:
        Math.max(1, framePaths.length) *
        Math.max(1, width) *
        Math.max(1, height) *
        VIDEO_DISK_ESTIMATE_FACTORS.segmentBytesPerPixel,
      operation: "编码临时视频分段",
    });
  } finally {
    if (typeof unbindProgress === "function") unbindProgress();
    combinator.destroy();
    frameClip.destroy();
  }
};

const exportProcessedBatchSegmentWithFfmpeg = async ({
  framePaths,
  outputPath,
  width,
  height,
  fps,
  progressBase,
  progressWeight,
  batchNumber,
  totalBatches,
  batchDurations,
  pipelineBatchDurations,
}) => {
  const missingFramePaths = await getMissingFilePaths(framePaths);
  if (missingFramePaths.length > 0) {
    const preview = missingFramePaths.slice(0, 2).join("；");
    const suffix = missingFramePaths.length > 2 ? " 等文件" : "";
    throw new Error(`当前批次缺少结果帧文件：${preview}${suffix}`);
  }

  updateBatchProcessingUi({
    batchNumber,
    totalBatches,
    stageLabel: "正在使用 FFmpeg 编码临时视频分段",
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount: getActiveStageRemainingBatchCount({ batchNumber, totalBatches }),
    progress: progressBase + progressWeight * 0.15,
    etaProgress: 0.15,
    phase: VIDEO_PROCESSING_PHASES.ENCODING,
  });
  await flushProcessingUiFrame();

  const result = await invokeVideoFfmpegIpc("ffmpeg-encode-frame-sequence", {
    framePaths,
    outputPath,
    width,
    height,
    fps,
    estimatedOutputBytes:
      Math.max(1, framePaths.length) *
      Math.max(1, width) *
      Math.max(1, height) *
      VIDEO_DISK_ESTIMATE_FACTORS.segmentBytesPerPixel,
    taskId: `video_segment_${batchNumber}_${Date.now()}`,
  });

  updateBatchProcessingUi({
    batchNumber,
    totalBatches,
    stageLabel: "FFmpeg 临时视频分段编码完成",
    batchDurations,
    pipelineBatchDurations,
    remainingBatchCount: getActiveStageRemainingBatchCount({ batchNumber, totalBatches }),
    progress: progressBase + progressWeight,
    etaProgress: 1,
    phase: VIDEO_PROCESSING_PHASES.ENCODING,
  });

  return result.filePath || outputPath;
};

const exportProcessedBatchSegment = async (options) =>
  runWithVideoProcessingEngine({
    stageLabel: "编码临时视频分段",
    webav: () => exportProcessedBatchSegmentWithWebAv(options),
    ffmpeg: () => exportProcessedBatchSegmentWithFfmpeg(options),
  });

const detectSourceHasAudio = async (sourceFile) => {
  let sourceClip = null;
  let splitTracks = [];

  try {
    sourceClip = new MP4Clip(sourceFile.stream());
    await sourceClip.ready;
    try {
      splitTracks = await sourceClip.splitTrack();
      return splitTracks.some(
        (track) =>
          Number(track.meta?.audioSampleRate || 0) > 0 &&
          Number(track.meta?.audioChanCount || 0) > 0
      );
    } catch {
      return (
        Number(sourceClip.meta?.audioSampleRate || 0) > 0 &&
        Number(sourceClip.meta?.audioChanCount || 0) > 0
      );
    }
  } finally {
    splitTracks.forEach((track) => track?.destroy?.());
    sourceClip?.destroy?.();
  }
};

const finalizeProcessedVideoWithWebAv = async ({
  segmentPaths,
  sourceFile,
  sourcePath,
  width,
  height,
  previewTrialSeconds = null,
}) => {
  await ensureMp4ExportSupported(width, height);
  const outputPath = await buildOutputVideoPath(sourceFile, sourcePath, {
    previewTrialSeconds,
  });
  await ensureVideoDiskSpace({
    targetPath: outputPath,
    requiredBytes:
      Math.max(Number(sourceFile?.size || 0), await sumFileSizes(segmentPaths)) *
      VIDEO_DISK_ESTIMATE_FACTORS.finalVideoMultiplier,
    safetyBytes: DISK_SPACE_SAFETY_BYTES,
    operation: "写入最终视频文件",
  });

  updateProcessingUi(
    "正在进行最后的拼接与封装",
    FINAL_CONCAT_PROGRESS_BASE,
    VIDEO_PROCESSING_PHASES.FINALIZING,
    0
  );
  await flushProcessingUiFrame();

  if (segmentPaths.length === 0) {
    throw new Error("没有可用于封装的视频分段");
  }

  let hasAudio = false;
  try {
    hasAudio = await detectSourceHasAudio(sourceFile);
  } catch (error) {
    throw new Error(formatProcessingStageError("检测源视频音轨", error));
  }

  if (!hasAudio) {
    if (segmentPaths.length === 1) {
      updateProcessingUi(
        "正在写入最终视频文件",
        0.98,
        VIDEO_PROCESSING_PHASES.WRITING
      );
      await flushProcessingUiFrame();
      try {
        return await saveStreamToPath(await openPathAsStream(segmentPaths[0]), outputPath, {
          estimatedBytes: await sumFileSizes(segmentPaths),
          operation: "写入最终视频文件",
        });
      } catch (error) {
        throw new Error(formatProcessingStageError("写入最终视频文件", error));
      }
    }

    if (segmentPaths.length <= FINAL_CONCAT_GROUP_SIZE) {
      updateProcessingUi(
        "正在拼接视频分段（1/1）",
        FINAL_CONCAT_PROGRESS_BASE,
        VIDEO_PROCESSING_PHASES.FINALIZING,
        0
      );
      await flushProcessingUiFrame();
      try {
        return await concatSegmentGroupToPath({
          segmentPaths,
          outputPath,
        });
      } catch (error) {
        throw new Error(formatProcessingStageError("拼接视频分段", error));
      }
    }

    try {
      const { mergedPath } = await concatSegmentPathsInLayers({
        segmentPaths,
        finalOutputPath: outputPath,
        reserveProgressForAudio: false,
      });
      return mergedPath || outputPath;
    } catch (error) {
      throw new Error(formatProcessingStageError("拼接视频分段", error));
    }
  }

  const transientPaths = [];

  try {
    let mergedPathForAudio = segmentPaths[0];
    if (segmentPaths.length > 1) {
      if (segmentPaths.length <= FINAL_CONCAT_GROUP_SIZE) {
        updateProcessingUi(
          "正在拼接视频分段（1/1）",
          FINAL_CONCAT_PROGRESS_BASE,
          VIDEO_PROCESSING_PHASES.FINALIZING,
          0
        );
        await flushProcessingUiFrame();
        try {
          mergedPathForAudio = await concatSegmentGroupToPath({
            segmentPaths,
            outputPath: buildIntermediateConcatPath({
              segmentDirectory: getDirectoryPath(segmentPaths[0]),
              roundIndex: 0,
              groupIndex: 0,
            }),
          });
          transientPaths.push(mergedPathForAudio);
        } catch (error) {
          throw new Error(formatProcessingStageError("拼接视频分段", error));
        }
      } else {
        try {
          const { mergedPath, intermediatePaths } = await concatSegmentPathsInLayers({
            segmentPaths,
            reserveProgressForAudio: true,
          });
          mergedPathForAudio = mergedPath;
          transientPaths.push(...intermediatePaths);
        } catch (error) {
          throw new Error(formatProcessingStageError("拼接视频分段", error));
        }
      }
    }

    updateProcessingUi(
      "正在混合原视频音频",
      FINAL_AUDIO_MIX_PROGRESS,
      VIDEO_PROCESSING_PHASES.FINALIZING,
      0.5
    );
    await flushProcessingUiFrame();

    let finalStream = null;
    try {
      finalStream = mixinMP4AndAudio(await openPathAsStream(mergedPathForAudio), {
        stream: sourceFile.stream(),
        volume: 1,
        loop: false,
      });
    } catch (error) {
      throw new Error(formatProcessingStageError("混合原视频音频", error));
    }

    updateProcessingUi(
      "正在写入最终视频文件",
      0.98,
      VIDEO_PROCESSING_PHASES.WRITING
    );
    await flushProcessingUiFrame();
    try {
      return await saveStreamToPath(finalStream, outputPath, {
        estimatedBytes:
          Math.max(Number(sourceFile?.size || 0), await sumFileSizes(segmentPaths)) *
          VIDEO_DISK_ESTIMATE_FACTORS.finalVideoMultiplier,
        operation: "写入最终视频文件",
      });
    } catch (error) {
      throw new Error(formatProcessingStageError("写入最终视频文件", error));
    }
  } finally {
    const removableTransientPaths = transientPaths.filter(
      (filePath) => filePath && !segmentPaths.includes(filePath) && filePath !== outputPath
    );
    if (removableTransientPaths.length > 0) {
      await removeTemporaryFiles(removableTransientPaths);
    }
  }
};

const ffprobeSourceHasAudio = async (sourcePath) => {
  const result = await invokeVideoFfmpegIpc("ffprobe-media", { inputPath: sourcePath });
  return Boolean(result.data?.hasAudio);
};

const buildFfmpegIntermediatePath = ({ segmentPaths, outputPath, suffix }) => {
  const baseDirectory = getDirectoryPath(segmentPaths[0] || outputPath);
  const baseName = outputPath
    .split(/[\\/]/)
    .pop()
    .replace(/\.[^.]+$/, "");
  return joinRendererPath(baseDirectory, `${baseName}_${suffix}_${Date.now()}.mp4`);
};

const finalizeProcessedVideoWithFfmpeg = async ({
  segmentPaths,
  sourceFile,
  sourcePath,
  previewTrialSeconds = null,
}) => {
  const outputPath = await buildOutputVideoPath(sourceFile, sourcePath, {
    previewTrialSeconds,
  });
  const estimatedFinalBytes =
    Math.max(Number(sourceFile?.size || 0), await sumFileSizes(segmentPaths)) *
    VIDEO_DISK_ESTIMATE_FACTORS.finalVideoMultiplier;
  await ensureVideoDiskSpace({
    targetPath: outputPath,
    requiredBytes: estimatedFinalBytes,
    safetyBytes: DISK_SPACE_SAFETY_BYTES,
    operation: "写入最终视频文件",
  });

  updateProcessingUi(
    "正在使用 FFmpeg 进行最后的拼接与封装",
    FINAL_CONCAT_PROGRESS_BASE,
    VIDEO_PROCESSING_PHASES.FINALIZING,
    0
  );
  await flushProcessingUiFrame();

  if (segmentPaths.length === 0) {
    throw new Error("没有可用于封装的视频分段");
  }

  let hasAudio = false;
  try {
    hasAudio = await ffprobeSourceHasAudio(sourcePath);
  } catch (error) {
    throw new Error(formatProcessingStageError("检测源视频音轨", error));
  }

  const transientPaths = [];
  try {
    if (!hasAudio) {
      const concatResult = await invokeVideoFfmpegIpc("ffmpeg-concat-segments", {
        segmentPaths,
        outputPath,
        estimatedOutputBytes: estimatedFinalBytes,
        taskId: `video_concat_${Date.now()}`,
      });
      return concatResult.filePath || outputPath;
    }

    let mergedPathForAudio = segmentPaths[0];
    if (segmentPaths.length > 1) {
      const mergedOutputPath = buildFfmpegIntermediatePath({
        segmentPaths,
        outputPath,
        suffix: "ffmpeg_concat",
      });
      const concatResult = await invokeVideoFfmpegIpc("ffmpeg-concat-segments", {
        segmentPaths,
        outputPath: mergedOutputPath,
        estimatedOutputBytes: estimatedFinalBytes,
        taskId: `video_concat_audio_${Date.now()}`,
      });
      mergedPathForAudio = concatResult.filePath || mergedOutputPath;
      transientPaths.push(mergedPathForAudio);
    }

    updateProcessingUi(
      "正在使用 FFmpeg 混合原视频音频",
      FINAL_AUDIO_MIX_PROGRESS,
      VIDEO_PROCESSING_PHASES.FINALIZING,
      0.5
    );
    await flushProcessingUiFrame();
    const muxResult = await invokeVideoFfmpegIpc("ffmpeg-mux-audio", {
      videoPath: mergedPathForAudio,
      sourcePath,
      outputPath,
      estimatedOutputBytes: estimatedFinalBytes,
      taskId: `video_mux_${Date.now()}`,
    });
    return muxResult.filePath || outputPath;
  } finally {
    const removableTransientPaths = transientPaths.filter(
      (filePath) => filePath && !segmentPaths.includes(filePath) && filePath !== outputPath
    );
    if (removableTransientPaths.length > 0) {
      await removeTemporaryFiles(removableTransientPaths);
    }
  }
};

const finalizeProcessedVideo = async (options) =>
  runWithVideoProcessingEngine({
    stageLabel: "视频最终封装",
    webav: () => finalizeProcessedVideoWithWebAv(options),
    ffmpeg: () => finalizeProcessedVideoWithFfmpeg(options),
  });

const buildBatchDescriptor = ({
  start,
  batchSize,
  totalFrames,
  batchNumber: explicitBatchNumber = null,
}) => {
  const batchNumber =
    explicitBatchNumber !== null && explicitBatchNumber !== undefined
      ? Math.max(1, Math.round(Number(explicitBatchNumber || 1)))
      : Math.floor(start / batchSize) + 1;
  const end = Math.min(totalFrames, start + batchSize);
  const batchFrameCount = end - start;
  const batchProgressBase =
    totalFrames > 0 ? Math.max(0, Math.min(0.85, (start / totalFrames) * 0.85)) : 0;
  const batchProgressSpan =
    totalFrames > 0
      ? Math.max(0, Math.min(0.85 - batchProgressBase, (batchFrameCount / totalFrames) * 0.85))
      : 0;

  return {
    start,
    end,
    batchNumber,
    batchFrameCount,
    batchProgressBase,
    batchProgressSpan,
  };
};

const getEnabledProcessingRanges = () =>
  videoStore.processingRanges
    .filter((range) => range?.enabled !== false)
    .map((range) => ({
      startTime: Math.max(0, Number(range.startTime || 0)),
      endTime: Math.min(videoStore.videoDuration, Math.max(0, Number(range.endTime || 0))),
    }))
    .filter((range) => range.endTime > range.startTime);

const shouldProcessFrameWithSlbr = ({ frameIndex, fps, ranges }) => {
  if (!Array.isArray(ranges) || ranges.length === 0) return true;
  const timestamp = frameIndex / Math.max(1, Number(fps || 1));
  return ranges.some(
    (range) => timestamp >= range.startTime && timestamp < range.endTime
  );
};

const prepareBatchArtifacts = async ({
  descriptor,
  paths,
  fps,
  frameFormat,
  extractor,
  maskRenderer,
  modelId = "lama",
  processingRanges = [],
  totalBatches,
  batchDurations,
  reportProgress = true,
}) => {
  const preparationStartedAt = performance.now();
  const {
    start,
    end,
    batchNumber,
    batchFrameCount,
    batchProgressBase,
    batchProgressSpan,
  } = descriptor;

  const batchItems = [];
  const batchArtifactPaths = [];
  const batchResultPaths = [];
  const frameDecodeFallbacks = [];

  for (let frameIndex = start; frameIndex < end; frameIndex += 1) {
    if (reportProgress) {
      const stageRatio = (frameIndex - start) / Math.max(batchFrameCount, 1);
      updateBatchProcessingUi({
        batchNumber,
        totalBatches,
        stageLabel: modelId === "slbr" ? "正在生成帧与判断范围" : "正在生成帧与蒙版",
        batchDurations,
        remainingBatchCount: getActiveStageRemainingBatchCount({ batchNumber, totalBatches }),
        progress:
          batchProgressBase +
          stageRatio * batchProgressSpan * 0.3,
        etaProgress: stageRatio,
        phase: VIDEO_PROCESSING_PHASES.STAGING,
      });
    }

    const ts = Math.min(videoStore.videoDuration, frameIndex / fps);
    const frameName = `frame_${String(frameIndex).padStart(6, "0")}.${frameFormat}`;
    const maskName = `mask_${String(frameIndex).padStart(6, "0")}.jpg`;
    const resultName = `result_${String(frameIndex).padStart(6, "0")}.${RESULT_FRAME_FORMAT}`;

    const framePath = window.electron.ipcRenderer.joinPath(paths.framesDir, frameName);
    const maskPath = window.electron.ipcRenderer.joinPath(paths.masksDir, maskName);
    const outputPath = window.electron.ipcRenderer.joinPath(paths.resultsDir, resultName);

    const frameRequiresMask = isMaskInpaintModel(modelId);
    const shouldProcessFrame =
      modelId !== "slbr" ||
      shouldProcessFrameWithSlbr({
        frameIndex,
        fps,
        ranges: processingRanges,
      });
    const [frameCaptureResult, maskBlob] = await Promise.all([
      extractor.capture(ts),
      frameRequiresMask ? maskRenderer.render(ts) : Promise.resolve(null),
    ]);
    const frameBlob = frameCaptureResult?.blob || frameCaptureResult;

    await saveBlobToPath(frameBlob, framePath);
    if (frameRequiresMask) {
      await saveBlobToPath(maskBlob, maskPath);
    }

    if (modelId === "slbr" && !shouldProcessFrame) {
      await saveBlobToPath(frameBlob.slice(0, frameBlob.size, frameBlob.type), outputPath);
    }

    if (frameCaptureResult?.degraded) {
      frameDecodeFallbacks.push({
        frameIndex,
        requestedTime: Number(ts.toFixed(6)),
        fallbackType: frameCaptureResult.fallbackType || "unknown",
        fallbackSourceTime: Number(
          Number(frameCaptureResult.fallbackSourceTime ?? ts).toFixed(6)
        ),
        error: frameCaptureResult.error || "",
      });
    }

    if (modelId !== "slbr" || shouldProcessFrame) {
      batchItems.push({
        frame_index: frameIndex,
        image_path: framePath,
        ...(frameRequiresMask ? { mask_path: maskPath } : {}),
        output_path: outputPath,
      });
    }
    batchArtifactPaths.push(
      ...[framePath, frameRequiresMask ? maskPath : "", outputPath].filter(Boolean)
    );
    batchResultPaths.push(outputPath);
  }

  return {
    ...descriptor,
    preparationSeconds: (performance.now() - preparationStartedAt) / 1000,
    batchItems,
    batchArtifactPaths,
    batchResultPaths,
    frameDecodeFallbacks,
  };
};

const createPreparedBatchTask = ({
  start,
  totalFrames,
  batchSize,
  totalBatches,
  batchNumber = null,
  paths,
  fps,
  frameFormat,
  extractor,
  maskRenderer,
  modelId,
  processingRanges,
  batchDurations,
  reportProgress,
}) => {
  if (start >= totalFrames) return null;

  const descriptor = buildBatchDescriptor({
    start,
    batchSize,
    totalFrames,
    totalBatches,
    batchNumber,
  });

  const preparationPromise = prepareBatchArtifacts({
    descriptor,
    paths,
    fps,
    frameFormat,
    extractor,
    maskRenderer,
    modelId,
    processingRanges,
    totalBatches,
    batchDurations,
    reportProgress,
  });

  return {
    descriptor,
    reportProgress,
    promise: preparationPromise.then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    ),
  };
};

const runVideoProcessingTask = async ({ previewTrialSeconds = null } = {}) => {
  const normalizedPreviewTrialSeconds =
    previewTrialSeconds === null || previewTrialSeconds === undefined
      ? null
      : Math.max(1, Number(previewTrialSeconds || 0));
  const isPreviewTrial = normalizedPreviewTrialSeconds !== null;
  let requestedModelId = currentModel.value || "lama";
  let requestedModelOptions = getCurrentModelOptionsPayload();
  let requestedProcessingRanges =
    requestedModelId === "slbr" ? getEnabledProcessingRanges() : [];

  if (backendEngineValue.value.runDisabled) {
    if (backendEngineValue.value.hasFailed) {
      backendEngineValue.value.openDiagnostics();
    }
    return;
  }

  const backendModelReady = await ensureBackendVideoModel(requestedModelId);
  if (!backendModelReady) return;
  requestedModelId = currentModel.value || "lama";
  requestedModelOptions = getCurrentModelOptionsPayload();
  requestedProcessingRanges =
    requestedModelId === "slbr" ? getEnabledProcessingRanges() : [];
  const requestedModelLabel =
    videoModelOptions.value.find((option) => option.value === requestedModelId)?.label ||
    requestedModelId.toUpperCase();

  const backendPathValidation = await validateBackendPathsForConfig(
    configStore.config.general || {}
  );
  if (!backendPathValidation.valid) {
    $q.notify({
      type: "negative",
      message: buildBackendPathBlockedMessage(backendPathValidation),
      position: "top",
      timeout: 6500,
    });
    return;
  }

  if (!canRun.value || isProcessing.value) return;

  isProcessing.value = true;
  processingSucceeded.value = false;
  processingProgress.value = 0;
  lastOutputPath.value = "";
  lastOutputIsPreview.value = false;
  resetProcessingEtaState();
  videoProcessingFallbackNotified = false;
  processingEtaState.sessionStartedAtMs = performance.now();
  applyProcessingUi(
    isPreviewTrial ? "准备试跑样片" : "准备处理任务",
    0,
    VIDEO_PROCESSING_PHASES.PREPARING
  );

  let paths = null;
  let tempSourcePath = "";
  let preparedBatchTask = null;
  let firstBatchRequestStartedAt = null;
  let extractor = null;
  let currentTaskMeta = null;
  let taskCleanupErrorMessage = "";
  let shouldCleanupCurrentTask = false;
  const frameDecodeFallbacks = [];
  let frameDecodeFallbackReportPath = "";

  try {
    if (!window.electron) {
      throw new Error("视频处理仅支持 Electron 模式");
    }

    const requestedBatchSize = computedBatchSize.value;
    const requestedFrameFormat = normalizeImageFormat(
      configStore.config.video?.frameExtractionFormat,
      "jpg"
    );
    const retryCount = Math.max(1, Number(configStore.config.video?.batchRetryCount || 3));
    const currentRequestedFps = Math.max(1, Number(exportFps.value || sourceFps.value || 30));
    const currentRequestedSnapshot = buildCurrentProcessingConfigSnapshot({
      fps: currentRequestedFps,
        batchSize: requestedBatchSize,
        frameFormat: requestedFrameFormat,
      });
    if (isPreviewTrial) {
      currentRequestedSnapshot.previewTrial = true;
      currentRequestedSnapshot.previewTrialSeconds = normalizedPreviewTrialSeconds;
    }
    const sourceInfo = await resolveVideoSourcePath(videoStore.videoFile);
    const sourcePath = sourceInfo.sourcePath;
    tempSourcePath = sourceInfo.temporarySourcePath || "";
    let fingerprintInfo = null;
    try {
      fingerprintInfo = await computeVideoFileFingerprint(sourcePath);
    } catch (error) {
      if (/File does not exist/i.test(String(error?.message || ""))) {
        await discardVideoTasksBySourcePath(sourcePath).catch(() => undefined);
      }
      throw error;
    }
    let resumeTaskMeta = isPreviewTrial
      ? null
      : await findLatestResumableVideoTask({
          fingerprint: fingerprintInfo.fingerprint,
          tempBase: resolveConfiguredTempBase(sourcePath),
        });

    if (resumeTaskMeta) {
      const validatedSegments = await getValidatedCompletedSegments(resumeTaskMeta);
      resumeTaskMeta = normalizeVideoTaskMeta({
        ...resumeTaskMeta,
        completedSegments: validatedSegments,
      });

      const resumeDecision = await promptResumeVideoTaskDecision({
        taskMeta: resumeTaskMeta,
        hasConfigMismatch:
          resumeTaskMeta.configSnapshot &&
          hasProcessingConfigMismatch(resumeTaskMeta.configSnapshot, currentRequestedSnapshot),
      });

      if (resumeDecision === "restart") {
        await discardVideoTask(resumeTaskMeta, {
          preserveTemporarySourcePath: tempSourcePath,
        });
        resumeTaskMeta = null;
      } else if (resumeDecision !== "resume") {
        return;
      }
    }

    const reusableSegments = resumeTaskMeta?.completedSegments || [];
    const resumeHasReusableSegments = reusableSegments.length > 0;
    const previousSnapshot = resumeTaskMeta?.configSnapshot || null;
    const structuralResumeFps =
      Number(previousSnapshot?.fps || 0) > 0
        ? Number(previousSnapshot.fps)
        : Math.max(
            1,
            Number(resumeTaskMeta?.totalFrames || 0) /
              Math.max(Number(videoStore.videoDuration || 0), 0.001)
          );
    const fps = resumeHasReusableSegments
      ? Math.max(1, structuralResumeFps || currentRequestedFps)
      : currentRequestedFps;
    const sourceTotalFrames = Math.max(1, Math.ceil(videoStore.videoDuration * fps));
    const previewTotalFrames = isPreviewTrial
      ? Math.max(
          1,
          Math.min(sourceTotalFrames, Math.ceil(normalizedPreviewTrialSeconds * fps))
        )
      : sourceTotalFrames;
    const totalFrames =
      resumeHasReusableSegments && Number(resumeTaskMeta?.totalFrames || 0) > 0
        ? Math.max(1, Math.round(Number(resumeTaskMeta.totalFrames)))
        : previewTotalFrames;
    const batchSize = Math.max(
      1,
      Math.round(Number(requestedBatchSize || previousSnapshot?.batchSize || 120))
    );
    const frameFormat = normalizeImageFormat(
      requestedFrameFormat || previousSnapshot?.frameFormat,
      "jpg"
    );
    const effectiveSnapshot = buildCurrentProcessingConfigSnapshot({
      fps,
      batchSize,
      frameFormat,
    });
    if (isPreviewTrial) {
      effectiveSnapshot.previewTrial = true;
      effectiveSnapshot.previewTrialSeconds = normalizedPreviewTrialSeconds;
    }
    const resumeStartFrame =
      reusableSegments.length > 0 ? reusableSegments[reusableSegments.length - 1].end : 0;
    const totalBatches = Math.max(
      reusableSegments.length || 0,
      reusableSegments.length + estimateRemainingBatchCount({
        totalFrames,
        startFrame: resumeStartFrame,
        batchSize,
      }),
      1
    );

    paths = await prepareTaskPaths({
      sourcePath,
      temporarySourcePath: tempSourcePath || resumeTaskMeta?.temporarySourcePath || "",
      resumeTaskMeta,
    });
    frameDecodeFallbackReportPath = paths.frameDecodeFallbackReportPath || "";
    await ensureVideoProcessingDiskSpace({
      sourcePath,
      tempBase: paths.tempBase,
      taskRoot: paths.taskRoot,
      framesDir: paths.framesDir,
      masksDir: paths.masksDir,
      resultsDir: paths.resultsDir,
      segmentsDir: paths.segmentsDir,
      hasMask: isMaskInpaintModel(requestedModelId),
      hasSamAssets: videoStore.masks.some((mask) => mask?.type === "samVideo"),
      frameCount: Math.max(1, totalFrames - resumeStartFrame),
    });

    currentTaskMeta = await persistVideoTaskMeta({
      ...(resumeTaskMeta || {}),
      taskId: paths.taskId,
      taskRoot: paths.taskRoot,
      tempBase: paths.tempBase,
      sourcePath: paths.sourcePath,
      sourceName:
        videoStore.currentSourceName ||
        videoStore.videoFile?.name ||
        getTaskDirectoryName(paths.sourcePath) ||
        "video.mp4",
      temporarySourcePath: paths.temporarySourcePath || "",
      fingerprint: fingerprintInfo.fingerprint,
      status: "running",
      createdAt: resumeTaskMeta?.createdAt || Date.now(),
      totalFrames,
      totalBatches,
      videoWidth: videoStore.videoWidth,
      videoHeight: videoStore.videoHeight,
      videoDuration: isPreviewTrial
        ? Math.min(videoStore.videoDuration, normalizedPreviewTrialSeconds)
        : videoStore.videoDuration,
      previewTrial: isPreviewTrial,
      previewTrialSeconds: normalizedPreviewTrialSeconds || 0,
      completedSegments: reusableSegments,
      configSnapshot: effectiveSnapshot,
      frameDecodeFallbackReportPath,
      lastError: "",
    });

    if (
      resumeTaskMeta?.temporarySourcePath &&
      resumeTaskMeta.temporarySourcePath !== paths.temporarySourcePath
    ) {
      await window.electron.ipcRenderer
        .invoke("cleanup-temp-file", resumeTaskMeta.temporarySourcePath)
        .catch(() => undefined);
    }

    if (resumeStartFrame < totalFrames) {
      extractor = await createFrameExtractor(videoStore.videoFile, frameFormat, fps);
    }

    try {
      const maskRenderer =
        currentModelRequiresMask.value && resumeStartFrame < totalFrames
          ? await createCombinedMaskRenderer({
              masks: videoStore.masks,
              width: videoStore.videoWidth,
              height: videoStore.videoHeight,
              modelId: requestedModelId,
            })
          : null;

      const segmentPaths = reusableSegments.map((segment) => segment.path);
      const batchDurations = [];
      const pipelineBatchDurations = [];
      let processedFrames = resumeStartFrame;

      if (segmentPaths.length > 0) {
        updateProcessingUi(
          "已复用上次任务中已完成的分段，正在继续处理",
          (processedFrames / totalFrames) * 0.85,
          VIDEO_PROCESSING_PHASES.PREPARING
        );
      }

      preparedBatchTask = createPreparedBatchTask({
        start: resumeStartFrame,
        totalFrames,
        batchSize,
        totalBatches,
        batchNumber: reusableSegments.length + 1,
        paths,
        fps,
        frameFormat,
        extractor,
        maskRenderer,
        modelId: requestedModelId,
        processingRanges: requestedProcessingRanges,
        batchDurations,
        reportProgress: true,
      });

      while (preparedBatchTask) {
        const currentTask = preparedBatchTask;

        if (!currentTask.reportProgress) {
          updateBatchProcessingUi({
            batchNumber: currentTask.descriptor.batchNumber,
            totalBatches,
            stageLabel:
              requestedModelId === "slbr"
                ? "正在生成帧与判断范围"
                : `正在使用 ${requestedModelLabel} 生成帧与蒙版`,
            batchDurations,
            pipelineBatchDurations,
            remainingBatchCount: getActiveStageRemainingBatchCount({
              batchNumber: currentTask.descriptor.batchNumber,
              totalBatches,
            }),
            progress: currentTask.descriptor.batchProgressBase,
            etaProgress: 0,
            phase: VIDEO_PROCESSING_PHASES.STAGING,
          });
        }

        const currentBatchResult = await currentTask.promise;
        if (!currentBatchResult.ok) {
          throw currentBatchResult.error;
        }
        const currentBatch = currentBatchResult.value;
        if (Array.isArray(currentBatch.frameDecodeFallbacks)) {
          frameDecodeFallbacks.push(...currentBatch.frameDecodeFallbacks);
        }
        const batchStartedAt = performance.now();

        preparedBatchTask = createPreparedBatchTask({
          start: currentBatch.end,
          totalFrames,
          batchSize,
          totalBatches,
          batchNumber: currentBatch.batchNumber + 1,
          paths,
          fps,
          frameFormat,
          extractor,
          maskRenderer,
          modelId: requestedModelId,
          processingRanges: requestedProcessingRanges,
          batchDurations,
          reportProgress: false,
        });

        let success = false;
        let lastError = null;

        for (let attempt = 1; attempt <= retryCount; attempt += 1) {
          try {
            if (firstBatchRequestStartedAt === null) {
              firstBatchRequestStartedAt = performance.now();
            }

            updateBatchProcessingUi({
              batchNumber: currentBatch.batchNumber,
              totalBatches,
              stageLabel:
                requestedModelId === "slbr" && currentBatch.batchItems.length === 0
                  ? "当前批次不在处理范围内，直接复用原视频帧"
                  : `正在使用 ${requestedModelLabel} 处理第 ${currentBatch.batchNumber}/${totalBatches} 批`,
              batchDurations,
              pipelineBatchDurations,
              remainingBatchCount: getActiveStageRemainingBatchCount({
                batchNumber: currentBatch.batchNumber,
                totalBatches,
              }),
              progress: currentBatch.batchProgressBase + currentBatch.batchProgressSpan * 0.45,
              phase:
                requestedModelId === "slbr" && currentBatch.batchItems.length === 0
                  ? VIDEO_PROCESSING_PHASES.STAGING
                  : VIDEO_PROCESSING_PHASES.BACKEND,
            });
            await flushProcessingUiFrame();

            const data =
              requestedModelId === "slbr" && currentBatch.batchItems.length === 0
                ? createSkippedVideoBatchResponse(currentBatch)
                : await submitVideoBatchInpaint({
                    model_id: requestedModelId,
                    frames: currentBatch.batchItems,
                    options: {
                      model_options: requestedModelOptions,
                      keep_mask_grayscale: false,
                      stop_on_error: true,
                      failure_root: paths.failureRoot,
                      failure_retention: configStore.config.video?.failureRetentionCount || 3,
                      batch_id: `batch_${currentBatch.start}_${currentBatch.end}`,
                      batch_number: currentBatch.batchNumber,
                      total_batches: totalBatches,
                      inpaint: {
                        prompt: "",
                        negative_prompt: "",
                        sd_seed: -1,
                      },
                    },
                  });

            if (
              !(processingEtaState.firstResponseSeconds > 0) &&
              firstBatchRequestStartedAt !== null
            ) {
              processingEtaState.firstResponseSeconds =
                (performance.now() - firstBatchRequestStartedAt) / 1000;
              refreshProcessingEtaEstimate();
            }

            await validateVideoBatchResponse({
              batch: currentBatch,
              responseData: data,
            });

            success = true;
            break;
          } catch (error) {
            lastError = error;
          }
        }

        if (!success) {
          throw new Error(
            `批次 ${currentBatch.start + 1}-${currentBatch.end} 连续 ${retryCount} 次失败，已停止处理。\n${lastError?.message || ""}`
          );
        }

        const segmentPath = window.electron.ipcRenderer.joinPath(
          paths.segmentsDir,
          `segment_${String(currentBatch.batchNumber).padStart(4, "0")}.mp4`
        );
        const savedSegmentPath = await exportProcessedBatchSegment({
          framePaths: currentBatch.batchResultPaths,
          outputPath: segmentPath,
          width: videoStore.videoWidth,
          height: videoStore.videoHeight,
          fps,
          progressBase: currentBatch.batchProgressBase + currentBatch.batchProgressSpan * 0.55,
          progressWeight: currentBatch.batchProgressSpan * 0.3,
          batchNumber: currentBatch.batchNumber,
          totalBatches,
          batchDurations,
          pipelineBatchDurations,
        });

        segmentPaths.push(savedSegmentPath || segmentPath);
        processedFrames += currentBatch.batchFrameCount;
        const currentBatchProcessingSeconds = (performance.now() - batchStartedAt) / 1000;
        batchDurations.push(currentBatchProcessingSeconds);
        pipelineBatchDurations.push(
          currentBatch.batchNumber === reusableSegments.length + 1
            ? Number(currentBatch.preparationSeconds || 0) + currentBatchProcessingSeconds
            : Math.max(Number(currentBatch.preparationSeconds || 0), currentBatchProcessingSeconds)
        );

        const completedSegmentEntry = buildCompletedSegmentEntry({
          segmentIndex: currentBatch.batchNumber,
          start: currentBatch.start,
          end: currentBatch.end,
          path: savedSegmentPath || segmentPath,
        });
        currentTaskMeta = await persistVideoTaskMeta({
          ...currentTaskMeta,
          completedSegments: [
            ...currentTaskMeta.completedSegments.filter(
              (segment) => segment.segmentIndex !== completedSegmentEntry.segmentIndex
            ),
            completedSegmentEntry,
          ].sort((left, right) => left.segmentIndex - right.segmentIndex),
          totalBatches: Math.max(currentTaskMeta.totalBatches, currentBatch.batchNumber),
        });

        updateBatchProcessingUi({
          batchNumber: currentBatch.batchNumber,
          totalBatches,
          stageLabel: "当前批次已完成",
          batchDurations,
          pipelineBatchDurations,
          progress: (processedFrames / totalFrames) * 0.85,
          remainingBatchCount: Math.max(0, totalBatches - currentBatch.batchNumber),
          etaProgress: 1,
          phase: VIDEO_PROCESSING_PHASES.ENCODING,
        });
      }

      const outputPath = await finalizeProcessedVideo({
        segmentPaths,
        sourceFile: videoStore.videoFile,
        sourcePath: paths.sourcePath,
        width: videoStore.videoWidth,
        height: videoStore.videoHeight,
        previewTrialSeconds: normalizedPreviewTrialSeconds,
      });

      lastOutputPath.value = outputPath;
      processingSucceeded.value = true;
      lastOutputIsPreview.value = isPreviewTrial;
      shouldCleanupCurrentTask = true;
      processingProgress.value = 1;
      const fallbackSummary =
        frameDecodeFallbacks.length > 0
          ? `${isPreviewTrial ? "样片试跑完成" : "处理完成"}（${frameDecodeFallbacks.length} 帧拆帧降级，已自动复用相邻成功帧）`
          : isPreviewTrial
          ? "样片试跑完成"
          : "处理完成";
      currentTaskMeta = await persistVideoTaskMeta({
        ...currentTaskMeta,
        status: "succeeded",
        lastOutputPath: outputPath,
        lastError: "",
      });
      updateProcessingUi(fallbackSummary, 1, VIDEO_PROCESSING_PHASES.COMPLETE);
      $q.notify({
        type: "positive",
        message:
          frameDecodeFallbacks.length > 0
            ? `${isPreviewTrial ? "样片试跑完成" : "视频处理完成"}，已导出: ${outputPath}\n其中 ${frameDecodeFallbacks.length} 帧发生本地解码降级，已自动补齐。\n诊断文件: ${frameDecodeFallbackReportPath}`
            : `${isPreviewTrial ? "样片试跑完成" : "视频处理完成"}，已导出: ${outputPath}`,
        position: "top",
        timeout: frameDecodeFallbacks.length > 0 ? 6500 : 4500,
      });
    } finally {
      if (preparedBatchTask?.promise) {
        await Promise.allSettled([preparedBatchTask.promise]);
      }
      await extractor?.dispose?.();
    }
  } catch (error) {
    if (currentTaskMeta?.taskId) {
      try {
        currentTaskMeta = await persistVideoTaskMeta({
          ...currentTaskMeta,
          status: "failed",
          lastError: error.message || String(error),
        });
      } catch (metaError) {
        console.warn("Failed to persist video task failure state:", metaError);
      }
    }

    processingSucceeded.value = false;
    updateProcessingUiWithoutOverlay(
      isPreviewTrial ? "样片试跑失败" : "处理失败",
      processingProgress.value,
      VIDEO_PROCESSING_PHASES.FAILED
    );
    hideGlobalLoadingOverlay();
    console.error("Video processing failed:", error);
    $q.notify({
      type: "negative",
      message: `${isPreviewTrial ? "样片试跑失败" : "视频处理失败"}: ${error.message}`,
      position: "top",
      timeout: 6000,
    });
  } finally {
    isProcessing.value = false;
    resetProcessingEtaState();
    loadingControl?.hide?.();
    const cleanupTasks = [];
    if (
      frameDecodeFallbacks.length > 0 &&
      frameDecodeFallbackReportPath &&
      window.electron?.ipcRenderer?.writeFile
    ) {
      cleanupTasks.push(
        writeJsonToPath(frameDecodeFallbackReportPath, {
          createdAt: new Date().toISOString(),
          sourcePath: paths?.sourcePath || videoStore.videoFile?.path || "",
          outputPath: lastOutputPath.value || "",
          totalFallbackFrames: frameDecodeFallbacks.length,
          frames: frameDecodeFallbacks,
        }).catch((reportError) => {
          console.warn("Failed to write frame decode fallback report:", reportError);
        })
      );
    }

    if (shouldCleanupCurrentTask && currentTaskMeta?.taskId) {
      cleanupTasks.push(
        discardVideoTask(currentTaskMeta).catch((cleanupError) => {
          taskCleanupErrorMessage = cleanupError?.message || "清理视频临时目录失败";
        })
      );
    } else if (tempSourcePath && window.electron && !currentTaskMeta?.taskId) {
      cleanupTasks.push(window.electron.ipcRenderer.invoke("cleanup-temp-file", tempSourcePath));
    }
    if (cleanupTasks.length > 0) {
      await Promise.allSettled(cleanupTasks);
    }
    if (taskCleanupErrorMessage) {
      $q.notify({
        type: "warning",
        message: `${taskCleanupErrorMessage}，可在全局设置中手动清理旧的临时目录。`,
        position: "top",
        timeout: 4500,
      });
    }
  }
};

const runVideoProcessing = () => runVideoProcessingTask();

const runVideoPreviewTrial = () =>
  runVideoProcessingTask({
    previewTrialSeconds: getConfiguredPreviewTrialSeconds(),
  });

const createVideoTaskId = () =>
  `video_task_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;

const prepareTaskPaths = async ({
  sourcePath,
  temporarySourcePath = "",
  resumeTaskMeta = null,
} = {}) => {
  const tempBase = resumeTaskMeta?.tempBase || resolveConfiguredTempBase(sourcePath);
  const taskRoot =
    resumeTaskMeta?.taskRoot ||
    window.electron.ipcRenderer.joinPath(
      tempBase,
      `${VIDEO_TASK_DIRECTORY_PREFIX}${Date.now()}_${Math.random()
        .toString(16)
        .slice(2, 8)}`
    );
  const taskId = resumeTaskMeta?.taskId || createVideoTaskId();

  const framesDir = window.electron.ipcRenderer.joinPath(taskRoot, "frames");
  const masksDir = window.electron.ipcRenderer.joinPath(taskRoot, "masks");
  const resultsDir = window.electron.ipcRenderer.joinPath(taskRoot, "results");
  const segmentsDir = window.electron.ipcRenderer.joinPath(taskRoot, "segments");
  const failureRoot = window.electron.ipcRenderer.joinPath(
    tempBase,
    "moonshine_video_failures"
  );
  const frameDecodeFallbackReportPath = window.electron.ipcRenderer.joinPath(
    failureRoot,
    `${taskRoot.split(/[\\/]/).pop()}_frontend_decode_fallbacks.json`
  );

  await window.electron.ipcRenderer.invoke("ensure-directory", taskRoot);
  await window.electron.ipcRenderer.invoke("ensure-directory", framesDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", masksDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", resultsDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", segmentsDir);
  await window.electron.ipcRenderer.invoke("ensure-directory", failureRoot);

  return {
    taskId,
    sourcePath,
    temporarySourcePath,
    tempBase,
    taskRoot,
    framesDir,
    masksDir,
    resultsDir,
    segmentsDir,
    failureRoot,
    frameDecodeFallbackReportPath,
  };
};

const resolveVideoSourcePath = async (file, options = {}) => {
  const { preferExistingPath = true } = options;
  const filePath = String(file?.path || "").trim();
  if (preferExistingPath && filePath && (await checkLocalFileExists(filePath))) {
    return {
      sourcePath: filePath,
      temporarySourcePath: "",
    };
  }
  if (!window.electron) throw new Error("无法解析视频文件路径");
  if (filePath && preferExistingPath) {
    console.warn("视频原始路径已不可用，正在保存临时视频副本:", filePath);
  }
  if (typeof file?.arrayBuffer !== "function") {
    throw new Error("原视频路径不可用，且当前会话无法读取视频内容，请重新选择视频文件");
  }

  let buffer;
  try {
    buffer = await file.arrayBuffer();
  } catch (error) {
    console.warn("读取视频文件内容失败:", error);
    throw new Error("原视频路径已失效，无法从当前会话缓存视频，请重新选择视频文件");
  }
  const sourcePath = await window.electron.ipcRenderer.invoke("save-temp-video", {
    fileName: file.name,
    buffer: new Uint8Array(buffer),
  });

  return {
    sourcePath,
    temporarySourcePath: sourcePath,
  };
};

const createFrameExtractor = async (file, format, fps) => {
  const createClipInstance = async () => {
    const nextClip = new MP4Clip(file.stream(), {
      __unsafe_hardwareAcceleration__: "no-preference",
      audio: false,
    });
    await nextClip.ready;
    return nextClip;
  };

  const getClipDurationSeconds = (activeClip) =>
    Math.max(0, Number(activeClip?.meta?.duration || 0) / 1e6);

  let clip = await createClipInstance();
  let clipDurationSeconds = getClipDurationSeconds(clip);
  let lastSuccessfulFrameBlob = null;
  let lastSuccessfulFrameTime = null;

  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(videoStore.videoWidth, videoStore.videoHeight)
      : document.createElement("canvas");
  canvas.width = videoStore.videoWidth;
  canvas.height = videoStore.videoHeight;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });

  let captureQueue = Promise.resolve();
  let disposed = false;
  const safeFps = Math.max(Number(fps || 0), 1);
  const frameStepSeconds = 1 / safeFps;
  const endGuardSeconds = Math.min(frameStepSeconds * 0.5, 0.02);
  const fallbackOffsets = [
    0,
    Math.min(FRAME_CAPTURE_FALLBACK_EPSILON_SECONDS, endGuardSeconds),
  ].filter((value, index, values) => value >= 0 && values.indexOf(value) === index);

  const decodeFrameFromClip = async (activeClip, requestedTime, maxSafeTime) => {
    let decodedFrame = null;
    let lastError = null;
    let lastTriedTime = Math.max(0, Math.min(maxSafeTime, requestedTime));

    for (const offset of fallbackOffsets) {
      const candidateTime = Math.max(0, Math.min(maxSafeTime, requestedTime - offset));
      lastTriedTime = candidateTime;
      try {
        const { video } = await activeClip.tick(candidateTime * 1e6);
        if (video) {
          decodedFrame = video;
          break;
        }
      } catch (error) {
        lastError = error;
      }
    }

    return {
      decodedFrame,
      lastError,
      lastTriedTime,
    };
  };

  const recreateClip = async () => {
    clip.destroy();
    clip = await createClipInstance();
    clipDurationSeconds = getClipDurationSeconds(clip);
  };

  const captureImpl = async (time) => {
    if (disposed) {
      throw new Error("拆帧器已释放");
    }

    const requestedTime = Math.max(0, Number(time || 0));
    const knownDurationSeconds = Math.max(
      0,
      Math.min(videoStore.videoDuration || clipDurationSeconds, clipDurationSeconds || Infinity)
    );
    const effectiveDurationSeconds =
      Number.isFinite(knownDurationSeconds) && knownDurationSeconds > 0
        ? knownDurationSeconds
        : Math.max(0, Number(videoStore.videoDuration || 0));
    const maxSafeTime = Math.max(0, effectiveDurationSeconds - endGuardSeconds);

    let { decodedFrame, lastError, lastTriedTime } = await decodeFrameFromClip(
      clip,
      requestedTime,
      maxSafeTime
    );

    if (!decodedFrame && !disposed) {
      await recreateClip();
      ({ decodedFrame, lastError, lastTriedTime } = await decodeFrameFromClip(
        clip,
        requestedTime,
        maxSafeTime
      ));
    }

    if (!decodedFrame) {
      const reason = lastError?.message ? `，${lastError.message}` : "";
      throw new Error(`无法解码视频帧: ${lastTriedTime.toFixed(3)}s${reason}`);
    }

    try {
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(decodedFrame, 0, 0, canvas.width, canvas.height);
      const nextBlob = await canvasToBlob(canvas, {
        mimeType: getMimeTypeForFormat(format),
        quality: INPUT_FRAME_QUALITY,
      });
      lastSuccessfulFrameBlob = nextBlob.slice(0, nextBlob.size, nextBlob.type);
      lastSuccessfulFrameTime = lastTriedTime;
      return {
        blob: nextBlob,
        degraded: false,
        fallbackType: "exact",
        fallbackSourceTime: lastTriedTime,
      };
    } finally {
      if (typeof decodedFrame.close === "function") {
        decodedFrame.close();
      }
    }
  };

  return {
    capture: (time) => {
      const task = captureQueue.then(async () => {
        try {
          return await captureImpl(time);
        } catch (error) {
          if (lastSuccessfulFrameBlob) {
            return {
              blob: lastSuccessfulFrameBlob.slice(
                0,
                lastSuccessfulFrameBlob.size,
                lastSuccessfulFrameBlob.type
              ),
              degraded: true,
              fallbackType: "reuse_previous_successful_frame",
              fallbackSourceTime: lastSuccessfulFrameTime,
              error: error?.message || String(error),
            };
          }
          ctx.clearRect(0, 0, canvas.width, canvas.height);
          const placeholderBlob = await canvasToBlob(canvas, {
            mimeType: getMimeTypeForFormat(format),
            quality: INPUT_FRAME_QUALITY,
          });
          lastSuccessfulFrameBlob = placeholderBlob.slice(
            0,
            placeholderBlob.size,
            placeholderBlob.type
          );
          lastSuccessfulFrameTime = Math.max(0, Number(time || 0));
          return {
            blob: placeholderBlob,
            degraded: true,
            fallbackType: "blank_frame_placeholder",
            fallbackSourceTime: lastSuccessfulFrameTime,
            error: error?.message || String(error),
          };
        }
      });
      captureQueue = task.catch(() => undefined);
      return task;
    },
    dispose: async () => {
      disposed = true;
      await Promise.allSettled([captureQueue]);
      clip.destroy();
    },
  };
};

const createCombinedMaskRenderer = async ({ masks, width, height, modelId = currentModel.value }) => {
  const canvas =
    typeof OffscreenCanvas !== "undefined"
      ? new OffscreenCanvas(width, height)
      : document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const anchor = getVideoCenterAnchor(width, height);
  const samFrameImageCache = new Map();
  const SAM_FRAME_IMAGE_CACHE_LIMIT = 72;
  const shouldAutoExpandSamVideoMasks = isMaskInpaintModel(modelId);

  const getSamFrameCacheKey = ({
    maskId,
    frameIndex,
    objectId,
    maskPath = "",
    maskSignature = "",
    expandPx = null,
  } = {}) =>
    [
      maskId,
      frameIndex,
      objectId,
      shouldAutoExpandSamVideoMasks ? "lama-expanded" : "original",
      shouldAutoExpandSamVideoMasks ? normalizeSamVideoExpandPx(expandPx) : "auto",
      maskPath || maskSignature,
    ].join(":");

  const rememberSamFrameImage = (key, image) => {
    if (!key || !image) return image;
    if (samFrameImageCache.has(key)) {
      samFrameImageCache.delete(key);
    }
    samFrameImageCache.set(key, image);
    while (samFrameImageCache.size > SAM_FRAME_IMAGE_CACHE_LIMIT) {
      const oldestKey = samFrameImageCache.keys().next().value;
      samFrameImageCache.delete(oldestKey);
    }
    return image;
  };

  const loadSamFrameMaskImage = async ({
    maskId,
    frameIndex,
    objectId,
    maskPath,
    maskSignature,
    expandPx,
  }) => {
    if (!maskPath) return null;
    const cacheKey = getSamFrameCacheKey({
      maskId,
      frameIndex,
      objectId,
      maskPath,
      maskSignature,
      expandPx,
    });
    const cached = samFrameImageCache.get(cacheKey);
    if (cached) {
      samFrameImageCache.delete(cacheKey);
      samFrameImageCache.set(cacheKey, cached);
      return cached;
    }
    try {
      const image = await loadImageElement(getLocalFileUrl(maskPath));
      return rememberSamFrameImage(
        cacheKey,
        await createBinaryAlphaMaskBitmap(image, width, height, {
          expandForLama: shouldAutoExpandSamVideoMasks,
          expandPx,
        })
      );
    } catch (error) {
      console.warn("加载 SAM 视频处理蒙版帧失败，已跳过该对象:", error);
      return null;
    }
  };

  const getSamFrameEntries = (mask) => {
    const entries = (mask.samFrames || [])
      .map((frame) => ({
        frameIndex: Number(frame.frameIndex || 0),
        time: Number(frame.time ?? 0),
        masks: (frame.masks || [])
          .map((item) => ({
            objectId: Number(item.objectId || 0),
            maskPath: item.maskPath || "",
            maskSignature: item.maskSignature || "",
          }))
          .filter((item) => item.objectId > 0 && item.maskPath),
      }))
      .filter((frame) => frame.masks.length > 0)
      .sort((a, b) => a.frameIndex - b.frameIndex);
    return entries;
  };

  const buildSamFrameIndex = (samFrames = []) =>
    samFrames
      .map((frame, index) => ({
        index,
        frameIndex: Number(frame.frameIndex || 0),
        time: Number(frame.time || 0),
      }))
      .sort((a, b) => a.time - b.time || a.frameIndex - b.frameIndex);

  const findNearestSamFrame = (asset, time = 0) => {
    const frames = asset?.samFrames || [];
    const frameIndex = asset?.samFrameIndex || [];
    if (!frames.length || !frameIndex.length) return null;

    const targetTime = Number(time || 0);
    if (targetTime <= frameIndex[0].time) return frames[frameIndex[0].index] || null;
    const last = frameIndex[frameIndex.length - 1];
    if (targetTime >= last.time) return frames[last.index] || null;

    let left = 0;
    let right = frameIndex.length - 1;
    while (left <= right) {
      const middle = Math.floor((left + right) / 2);
      const middleTime = frameIndex[middle].time;
      if (middleTime === targetTime) return frames[frameIndex[middle].index] || null;
      if (middleTime < targetTime) left = middle + 1;
      else right = middle - 1;
    }

    const previous = frameIndex[Math.max(0, right)];
    const next = frameIndex[Math.min(frameIndex.length - 1, left)];
    const nearest =
      Math.abs(targetTime - previous.time) <= Math.abs(next.time - targetTime)
        ? previous
        : next;
    return frames[nearest.index] || null;
  };

  const assets = await Promise.all(
    masks.map(async (mask) => {
      if (mask.type === "samVideo") {
        const samFrames = getSamFrameEntries(mask);
        return {
          mask,
          image: null,
          samFrames,
          samFrameIndex: buildSamFrameIndex(samFrames),
        };
      }
      if (!mask.baseMaskDataUrl) {
        return { mask, image: null, samFrames: [] };
      }

      return {
        mask,
        image: await loadImageElement(mask.baseMaskDataUrl),
        samFrames: [],
      };
    })
  );

  return {
    render: async (time) => {
      ctx.clearRect(0, 0, width, height);

      for (const asset of assets) {
        if (asset.mask.type === "samVideo") {
          if (!asset.mask.enabled) continue;
          const state = getInterpolatedMaskTransform(asset.mask, time);
          if (!state || !asset.samFrames?.length) continue;
          const enabledObjects = new Set(
            (asset.mask.samObjects || [])
              .filter((item) => item.enabled !== false)
              .map((item) => Number(item.objectId))
          );
          if (enabledObjects.size === 0) continue;
          const samObjectMap = new Map(
            (asset.mask.samObjects || []).map((item) => [
              Number(item.objectId),
              normalizeSamVideoExpandPx(item.expandPx, item.autoExpandPx),
            ])
          );
          const nearestFrame = findNearestSamFrame(asset, time);
          if (!nearestFrame) continue;

          for (const item of nearestFrame.masks) {
            if (!enabledObjects.has(Number(item.objectId))) continue;
            const image = await loadSamFrameMaskImage({
              maskId: asset.mask.id,
              frameIndex: nearestFrame.frameIndex,
              objectId: item.objectId,
              maskPath: item.maskPath,
              maskSignature: item.maskSignature,
              expandPx: samObjectMap.get(Number(item.objectId)) ?? 0,
            });
            if (image) {
              ctx.drawImage(image, 0, 0, width, height);
            }
          }
          continue;
        }
        if (!asset.image) continue;

        const state = getInterpolatedMaskTransform(asset.mask, time);
        if (!state) continue;

        ctx.save();
        ctx.translate(anchor.x + state.x, anchor.y + state.y);
        ctx.scale(state.scaleX ?? state.scale ?? 1, state.scaleY ?? state.scale ?? 1);
        ctx.translate(-anchor.x, -anchor.y);
        ctx.drawImage(asset.image, 0, 0, width, height);
        ctx.restore();
      }

      // Replace the expensive full-frame pixel scan with GPU-friendly compositing:
      // keep only the accumulated alpha, then fill the visible mask area with white.
      ctx.save();
      ctx.globalCompositeOperation = "source-in";
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, width, height);
      ctx.restore();

      return encodeMaskImageAsJpegBlob(canvas, width, height);
    },
  };
};

const openOutputDir = async () => {
  if (!canOpenOutput.value || !lastOutputPath.value || !window.electron) return;
  try {
    const result = await window.electron.ipcRenderer.invoke("show-item-in-folder", {
      filePath: lastOutputPath.value,
    });
    if (!result?.success) {
      throw new Error(result?.error || "打开目录失败");
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `打开目录失败: ${error.message}`,
      position: "top",
      timeout: 3000,
    });
  }
};

const estimateFpsFromVideo = async (file) => {
  let objectUrl = "";
  let video = null;
  let callbackId = null;

  try {
    video = document.createElement("video");
    objectUrl = URL.createObjectURL(file);
    video.preload = "auto";
    video.muted = true;
    video.playsInline = true;
    video.src = objectUrl;

    await once(video, "loadedmetadata");
    await once(video, "loadeddata");

    if (typeof video.requestVideoFrameCallback !== "function") {
      return 30;
    }

    const estimatedFps = await new Promise((resolve) => {
      const timeoutId = window.setTimeout(() => {
        if (callbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
          video.cancelVideoFrameCallback(callbackId);
        }
        resolve(30);
      }, 4000);

      let firstFrame = null;

      const finish = (value) => {
        window.clearTimeout(timeoutId);
        resolve(value);
      };

      const sampleFrame = (_now, metadata) => {
        if (!firstFrame) {
          firstFrame = {
            mediaTime: metadata.mediaTime,
            presentedFrames: metadata.presentedFrames,
          };
          callbackId = video.requestVideoFrameCallback(sampleFrame);
          return;
        }

        const frameDelta = metadata.presentedFrames - firstFrame.presentedFrames;
        const timeDelta = metadata.mediaTime - firstFrame.mediaTime;
        const reachedEnoughFrames = frameDelta >= 24;
        const reachedEnoughTime = timeDelta >= Math.min(Math.max(video.duration * 0.15, 0.4), 1.2);

        if (!reachedEnoughFrames && !reachedEnoughTime) {
          callbackId = video.requestVideoFrameCallback(sampleFrame);
          return;
        }

        const fps = frameDelta > 0 && timeDelta > 0 ? frameDelta / timeDelta : 30;
        finish(Number.isFinite(fps) && fps > 0 ? Math.round(fps * 100) / 100 : 30);
      };

      video
        .play()
        .then(() => {
          callbackId = video.requestVideoFrameCallback(sampleFrame);
        })
        .catch(() => finish(30));
    });

    video.pause();
    return estimatedFps;
  } catch {
    return 30;
  } finally {
    if (video && callbackId !== null && typeof video.cancelVideoFrameCallback === "function") {
      video.cancelVideoFrameCallback(callbackId);
    }
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.load();
    }
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
    }
  }
};

const once = (target, event) =>
  new Promise((resolve, reject) => {
    const cleanup = () => {
      target.removeEventListener(event, onOk);
      target.removeEventListener("error", onError);
    };
    const onOk = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error(`事件失败: ${event}`));
    };
    target.addEventListener(event, onOk, { once: true });
    target.addEventListener("error", onError, { once: true });
  });

const canvasToBlob = async (canvas, { mimeType = "image/png", quality } = {}) => {
  if (typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({
      type: mimeType,
      quality,
    });
  }

  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) {
        reject(new Error("无法生成图像数据"));
        return;
      }
      resolve(blob);
    }, mimeType, quality);
  });
};

const saveBlobToPath = async (blob, filePath) => {
  const buffer = await blob.arrayBuffer();
  if (typeof window.electron?.ipcRenderer?.writeFile === "function") {
    await window.electron.ipcRenderer.writeFile(filePath, new Uint8Array(buffer));
    return;
  }
  await window.electron.ipcRenderer.invoke("save-file", {
    filePath,
    blob: buffer,
  });
};

class ProcessedFramesClip {
  constructor({ framePaths, width, height, fps }) {
    this.framePaths = framePaths;
    this.width = width;
    this.height = height;
    this.fps = fps;
    this.frameDurationUs = 1e6 / fps;
    this.cache = new Map();
    this.meta = {
      width,
      height,
      duration: Math.round((framePaths.length / fps) * 1e6),
      audioSampleRate: 0,
      audioChanCount: 0,
    };
    this.ready = Promise.resolve(this.meta);
  }

  async tick(time) {
    const index = Math.floor(time / this.frameDurationUs);
    if (index >= this.framePaths.length) {
      return { audio: [], state: "done" };
    }

    const video = await this.loadFrame(index);
    return {
      video,
      audio: [],
      state: index >= this.framePaths.length - 1 ? "done" : "success",
    };
  }

  async loadFrame(index) {
    if (this.cache.has(index)) return this.cache.get(index);

    const framePath = this.framePaths[index];
    const response = await fetchLocalFileResponse(framePath);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    this.cache.set(index, bitmap);

    if (this.cache.size > 12) {
      const firstKey = this.cache.keys().next().value;
      const first = this.cache.get(firstKey);
      if (first && typeof first.close === "function") first.close();
      this.cache.delete(firstKey);
    }

    return bitmap;
  }

  async clone() {
    return new ProcessedFramesClip({
      framePaths: [...this.framePaths],
      width: this.width,
      height: this.height,
      fps: this.fps,
    });
  }

  destroy() {
    this.cache.forEach((bitmap) => {
      if (bitmap && typeof bitmap.close === "function") {
        bitmap.close();
      }
    });
    this.cache.clear();
  }
}

const handleResize = () => {
  scheduleLayoutMetricsUpdate();
};

const applyVideoBrushDefaults = () => {
  videoStore.setMaskToolDefaults(configStore.config.advanced?.videoBrushDefault, {
    syncActive: !videoStore.hasVideoFile,
    preserveInteraction: true,
  });
};

const preserveVideoPagePlaybackState = () => {
  if (!videoStore.hasVideoFile) {
    return;
  }

  if (videoStore.isPlaying) {
    canvasPlayerRef.value?.pause?.();
    videoStore.setIsPlaying(false);
  }
};

const createVideoE2ESnapshot = () => {
  const selectedMask = videoStore.selectedMask || null;
  const selectedSamFrames =
    selectedMask?.type === "samVideo" && Array.isArray(selectedMask.samFrames)
      ? selectedMask.samFrames
      : [];
  const selectedSamObjects =
    selectedMask?.type === "samVideo" && Array.isArray(selectedMask.samObjects)
      ? selectedMask.samObjects
      : [];
  return {
    hasVideoFile: videoStore.hasVideoFile,
    videoFileName: videoStore.videoFile?.name || "",
    videoWidth: videoStore.videoWidth,
    videoHeight: videoStore.videoHeight,
    videoDuration: videoStore.videoDuration,
    maskCount: videoStore.masks.length,
    selectedMaskId: videoStore.selectedMaskId,
    selectedMaskName: selectedMask?.name || "",
    selectedMaskType: selectedMask?.type || "",
    selectedMaskBaseMask: selectedMask?.baseMaskDataUrl || "",
    selectedSamFrameCount: selectedSamFrames.length,
    selectedSamObjectCount: selectedSamObjects.length,
    selectedSamFirstFrameMaskCount: selectedSamFrames[0]?.masks?.length || 0,
    selectedSamHasPreviewMask: selectedSamFrames.some((frame) =>
      (frame.masks || []).some((item) => item.maskPath)
    ),
    canUndoMaskDraw: videoStore.canUndoSelectedMaskDraw,
    historyLength: videoStore.videoHistory.length,
    timelineRowCount: timelineRows.value.length,
    currentSourceName: videoStore.currentSourceName || "",
    currentSourceIsReplacement: videoStore.currentSourceIsReplacement,
    samVideo: {
      panelOpen: samVideoState.panelOpen,
      running: samVideoState.running,
      canRun: canRunSamVideoPropagation.value,
      message: samVideoState.message,
      resultFrameCount: samVideoState.lastResultSummary?.frameCount || 0,
      lastTrackId: samVideoState.lastTrackId,
      trackCount: videoStore.masks.filter((mask) => mask.type === "samVideo").length,
    },
  };
};

const registerVideoE2ETestBridge = () => {
  if (typeof window === "undefined" || window.__MOONSHINE_E2E__ !== true) return;

  window.__MOONSHINE_VIDEO_TEST__ = {
    loadVideoFile: async (
      file,
      { width = 320, height = 180, duration = 5, fps = 30 } = {}
    ) => {
      suppressSourceCleanupWatcher = true;
      file.__moonshineE2EMockVideo = true;
      file.__moonshineE2EVideoWidth = width;
      file.__moonshineE2EVideoHeight = height;
      file.__moonshineE2EVideoDuration = duration;

      try {
        await videoStore.setVideoFile(file, {
          resetEditor: true,
          resetHistory: true,
          isReplacementSource: false,
          sourcePath: file.path || `e2e://${file.name || "sample.mp4"}`,
          sourceName: file.name || "sample.mp4",
        });
        videoStore.setVideoInfo(width, height, duration);
        videoStore.setSourceFrameRate(fps);
        videoStore.calculateDisplaySize(width, height);
        await nextTick();
        syncTimelineRowsFromStore();
        return createVideoE2ESnapshot();
      } finally {
        await nextTick();
        suppressSourceCleanupWatcher = false;
      }
    },
    createMask: (options = {}) => {
      const mask = videoStore.createMask({
        name: options.name || "E2E 蒙版",
        startTime: options.startTime ?? 0,
        endTime: options.endTime ?? videoStore.videoDuration,
      });
      syncTimelineRowsFromStore();
      return {
        maskId: mask?.id || "",
        snapshot: createVideoE2ESnapshot(),
      };
    },
    createEmptySamVideoTrack: (options = {}) => {
      const mask = videoStore.createEmptySamVideoMaskTrack({
        name: options.name || "E2E SAM 智能选区",
      });
      syncTimelineRowsFromStore();
      return {
        maskId: mask?.id || "",
        snapshot: createVideoE2ESnapshot(),
      };
    },
    commitSelectedMaskBaseMask: (baseMaskDataUrl) => {
      const mask = videoStore.commitSelectedMaskBaseMask(baseMaskDataUrl);
      return {
        maskId: mask?.id || "",
        snapshot: createVideoE2ESnapshot(),
      };
    },
    updateSelectedSamVideoResult: (result = {}) => {
      const maskId = videoStore.selectedMaskId;
      const updateResult = videoStore.updateSamVideoMaskTrackResult(maskId, result);
      samVideoState.lastResultSummary = summarizeSamVideoResult(result);
      syncTimelineRowsFromStore();
      return {
        success: Boolean(updateResult?.ok),
        error: updateResult?.error || "",
        maskId: updateResult?.mask?.id || "",
        snapshot: createVideoE2ESnapshot(),
      };
    },
    undoSelectedMaskDraw: () => {
      const mask = videoStore.undoSelectedMaskDraw();
      return {
        maskId: mask?.id || "",
        snapshot: createVideoE2ESnapshot(),
      };
    },
    removeSelectedMask: async () => {
      const maskId = videoStore.selectedMaskId;
      if (maskId) {
        await removeVideoMaskTrack(maskId);
      }
      return createVideoE2ESnapshot();
    },
    pushProcessingHistory: (label = "E2E 模型处理前") => {
      const entry = videoStore.buildHistoryEntry({
        label,
        uiState: captureVideoUiState(),
      });
      videoStore.pushHistoryEntry(entry, getConfiguredVideoHistoryLimit());
      return {
        entryId: entry?.id || "",
        snapshot: createVideoE2ESnapshot(),
      };
    },
    replaceWithProcessedMock: async (
      fileName = "processed-e2e.mp4",
      { width = videoStore.videoWidth, height = videoStore.videoHeight, duration = videoStore.videoDuration } = {}
    ) => {
      suppressSourceCleanupWatcher = true;
      const file = new File(["moonshine-e2e-processed"], fileName, {
        type: "video/mp4",
        lastModified: Date.now(),
      });
      file.__moonshineE2EMockVideo = true;
      file.__moonshineE2EVideoWidth = width;
      file.__moonshineE2EVideoHeight = height;
      file.__moonshineE2EVideoDuration = duration;

      try {
        await videoStore.setVideoFile(file, {
          resetEditor: true,
          resetHistory: false,
          isReplacementSource: true,
          sourcePath: `e2e://${fileName}`,
          sourceName: fileName,
        });
        videoStore.setVideoInfo(width, height, duration);
        videoStore.calculateDisplaySize(width, height);
        await nextTick();
        syncTimelineRowsFromStore();
        return createVideoE2ESnapshot();
      } finally {
        await nextTick();
        suppressSourceCleanupWatcher = false;
      }
    },
    undoLatestProcessing: async () => {
      const entry = videoStore.videoHistory.at(-1);
      if (!entry) {
        return {
          restored: false,
          snapshot: createVideoE2ESnapshot(),
        };
      }

      suppressSourceCleanupWatcher = true;
      try {
        await videoStore.setVideoFile(entry.videoFile, {
          resetEditor: true,
          resetHistory: false,
          isReplacementSource: Boolean(entry.isReplacement),
          sourcePath: entry.filePath || entry.videoFile?.path || "",
          sourceName: entry.fileName || entry.videoFile?.name || "",
        });
        const restored = videoStore.restoreEditorSnapshot(entry.snapshot, {
          preserveVideoInfo: false,
        });
        videoStore.removeHistoryFrom(entry.id);
        await restoreVideoUiState(restored.uiState || {});
        await nextTick();
        syncTimelineRowsFromStore();
        return {
          restored: true,
          snapshot: createVideoE2ESnapshot(),
        };
      } finally {
        suppressSourceCleanupWatcher = false;
      }
    },
    getSnapshot: createVideoE2ESnapshot,
  };
};

const unregisterVideoE2ETestBridge = () => {
  if (typeof window !== "undefined" && window.__MOONSHINE_VIDEO_TEST__) {
    delete window.__MOONSHINE_VIDEO_TEST__;
  }
};

onMounted(async () => {
  await configStore.loadConfig();
  previewTrialSeconds.value = getConfiguredPreviewTrialSeconds();
  applyVideoBrushDefaults();
  await restoreVideoUiState(appStateStore.restoreUIState("video") || {});
  await loadVideoModelOptions({ preferredModel: currentModel.value });
  await refreshSamVideoTextLexicon();
  canPersistVideoUiState = true;
  persistVideoUiStateToAppState();
  await nextTick();
  observePreviewStageSize();
  updateLayoutMetrics();
  window.addEventListener("resize", handleResize);
  document.addEventListener("fullscreenchange", handleDocumentFullscreenChange);
  window.addEventListener("moonshine-model-registry-updated", handleModelRegistryUpdated);
  window.addEventListener("moonshine-switch-model", handleGlobalModelSwitch);
  registerVideoE2ETestBridge();
});

watch(
  () => configStore.config.advanced?.videoBrushDefault,
  () => {
    applyVideoBrushDefaults();
  },
  {
    deep: true,
  }
);

watch(
  () => backendEngineValue.value.isRunning || backendRunningState.value,
  async (isRunning, wasRunning) => {
    if (isRunning && !wasRunning) {
      await loadVideoModelOptions({ preferredModel: currentModel.value });
    }
  },
  {
    flush: "post",
  }
);

onBeforeRouteLeave(() => {
  if (canPersistVideoUiState) {
    persistVideoUiStateToAppState();
  }
  preserveVideoPagePlaybackState();
  void exitPreviewFullscreenIfNeeded();
});

onUnmounted(() => {
  clearActiveProcessingTask(VIDEO_PROCESSING_TASK_ID);
  if (samVideoState.running) {
    hideGlobalLoadingOverlay();
  }
  unregisterVideoE2ETestBridge();
  canPersistVideoUiState = false;
  preserveVideoPagePlaybackState();
  void exitPreviewFullscreenIfNeeded();
  window.removeEventListener("resize", handleResize);
  document.removeEventListener("fullscreenchange", handleDocumentFullscreenChange);
  window.removeEventListener("moonshine-model-registry-updated", handleModelRegistryUpdated);
  window.removeEventListener("moonshine-switch-model", handleGlobalModelSwitch);
  clearPreviewFullscreenExitTimer();
  clearFullscreenBottomControlsHideTimer();
  clearFullscreenZoomSessionTimer();
  clearFullscreenPlaybackPauseSessions();
  finishFullscreenViewportPan();
  stopFullscreenDrawingToolbarDrag({
    pointerId: fullscreenDrawingToolbarDragContext?.pointerId,
  });
  disconnectPreviewStageResizeObserver();
  cancelScheduledLayoutUpdate();
});
</script>

<style scoped>
.video-page {
  height: calc(100vh - 50px);
  position: relative;
}

.processing-page-mask {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.08);
  z-index: 1200;
  cursor: not-allowed;
}

.video-layout {
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
  padding: 10px;
  overflow-x: auto;
  overflow-y: hidden;
}

.top-row {
  display: grid;
  grid-template-columns: 320px 1fr 360px;
  gap: 10px;
  min-height: 0;
  height: 100%;
  min-width: 980px;
}

.top-row.has-timeline {
  height: calc(100% - 260px);
}

.left-panel,
.center-panel,
.right-panel,
.timeline-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}

.side-panel-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
}

.player-section {
  flex: 1 1 auto;
  height: 100%;
  display: flex;
  flex-direction: column;
  justify-content: center;
  min-height: 0;
}

.preview-stage-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
}

.fullscreen-viewport-host {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

.sam-video-floating-toolbar {
  position: absolute !important;
  pointer-events: auto !important;
  touch-action: none;
  user-select: none;
  overflow: hidden;
  width: max-content;
  max-width: min(680px, calc(100vw - 24px));
  border-radius: 22px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  box-shadow: 0 14px 36px rgba(15, 23, 42, 0.18);
  backdrop-filter: blur(14px);
  background: rgba(255, 255, 255, 0.9);
}

.sam-video-floating-toolbar__bar {
  min-height: 58px;
  padding: 8px 22px 10px;
  border: none !important;
  gap: 8px;
  background: transparent;
}

.sam-video-floating-toolbar__controls {
  display: flex;
  align-items: center;
  gap: 8px;
  width: max-content;
  min-width: 0;
  flex-wrap: nowrap;
}

.sam-video-tool-group {
  min-height: 42px;
  flex: 0 0 auto;
}

.sam-video-tool-group :deep(.q-btn) {
  min-width: 46px;
  min-height: 42px;
  border-radius: 0;
}

.sam-video-floating-toolbar__controls > :deep(.q-btn) {
  min-width: 42px;
  min-height: 42px;
}

.video-sam-popup-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 8px;
}

.video-sam-popup-header--compact {
  margin-bottom: 4px;
}

.video-sam-settings-title {
  font-weight: 700;
  letter-spacing: 0.01em;
}

.video-sam-settings-panel,
.video-sam-candidate-panel {
  min-width: 260px;
  max-width: min(360px, calc(100vw - 32px));
}

.video-sam-settings-panel {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.sam-lexicon-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
  gap: 8px;
}

.sam-lexicon-select :deep(.q-field__control) {
  min-height: 36px;
}

.sam-cpu-risk-card {
  width: min(420px, calc(100vw - 32px));
}

.video-sam-object-expand-input {
  width: 76px;
}

.video-sam-object-expand-input :deep(.q-field__control) {
  min-height: 32px;
  padding: 0 4px;
}

.video-sam-object-expand-input :deep(input) {
  padding: 0;
}

.video-sam-settings-item {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 0;
}

.video-sam-settings-item.is-disabled {
  opacity: 0.72;
}

:global(.video-sam-settings-popup),
:global(.video-sam-candidate-popup) {
  border-radius: 18px;
  border: 1px solid rgba(17, 24, 39, 0.08);
  background: rgba(255, 255, 255, 0.96);
  box-shadow: 0 18px 40px rgba(15, 23, 42, 0.2);
  backdrop-filter: blur(14px);
  overflow: hidden;
}

:global(body.body--dark .video-sam-settings-popup),
:global(body.body--dark .video-sam-candidate-popup) {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(24, 24, 27, 0.96);
  color: rgba(244, 244, 245, 0.94);
}

.toolbar-handle {
  cursor: move !important;
  border-top-left-radius: 20px;
  border-top-right-radius: 20px;
  letter-spacing: 0.02em;
}

:global(body.body--dark) .sam-video-floating-toolbar {
  border-color: rgba(255, 255, 255, 0.08);
  background: rgba(24, 24, 27, 0.94);
  color: rgba(244, 244, 245, 0.94);
}

.preview-stage-wrap:fullscreen {
  width: 100vw;
  height: 100vh;
  background: #000;
  display: flex;
  align-items: center;
  justify-content: center;
}

.player-canvas {
  flex: 1;
  min-height: 0;
  width: 100%;
  height: 100%;
}

.preview-stage-wrap:fullscreen .player-canvas {
  width: 100%;
  height: 100%;
}

.fullscreen-exit-overlay {
  position: absolute;
  top: 0;
  left: 50%;
  transform: translateX(-50%);
  width: min(260px, 42vw);
  padding: 10px 0 0;
  display: flex;
  justify-content: center;
  opacity: 0;
  pointer-events: auto;
  transition: opacity 0.16s ease;
  z-index: 9;
}

.preview-stage-wrap--fullscreen-exit-visible .fullscreen-exit-overlay {
  opacity: 1;
}

.fullscreen-exit-button {
  min-height: 38px;
  box-shadow: 0 10px 24px rgba(15, 23, 42, 0.36);
}

.fullscreen-bottom-controls {
  position: absolute;
  left: 12px;
  right: 12px;
  bottom: 12px;
  z-index: 9;
  opacity: 0;
  pointer-events: none;
  transform: translateY(20px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}

.fullscreen-bottom-controls.is-visible {
  opacity: 1;
  pointer-events: auto;
  transform: translateY(0);
}

.fullscreen-bottom-controls-row {
  min-height: 54px;
  border-radius: 14px;
  padding: 8px 10px;
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(15, 23, 42, 0.6);
  backdrop-filter: blur(6px);
}

.fullscreen-progress-control {
  display: flex;
  align-items: center;
  flex: 1 1 auto;
  min-width: 220px;
  gap: 10px;
}

.timeline-panel {
  height: 250px;
  min-width: 980px;
}

.timeline-controls {
  flex: 0 0 auto;
  padding: 8px 12px 0;
}

.timeline-controls-disabled {
  opacity: 0.72;
}

.timeline-controls-scroll {
  overflow: hidden;
}

.timeline-controls-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  white-space: nowrap;
}

.timeline-playback-dropdown {
  min-width: 66px;
}

.timeline-progress-control {
  flex: 1 1 420px;
  min-width: 220px;
  display: flex;
  align-items: center;
  gap: 10px;
}

.timeline-progress-slider {
  flex: 1 1 auto;
  min-width: 0;
}

.timeline-time-display {
  flex: 0 0 auto;
  min-width: 90px;
  font-size: 12px;
  text-align: right;
}

.timeline-time-display--dark {
  color: rgba(255, 255, 255, 0.85);
}

:global(body.body--dark) .video-page {
  background: var(--q-primary);
}

:global(body.body--dark) .left-panel,
:global(body.body--dark) .center-panel,
:global(body.body--dark) .right-panel,
:global(body.body--dark) .timeline-panel {
  background: var(--q-primary);
  color: rgba(255, 255, 255, 0.92);
}

.timeline-time-display--light {
  color: rgba(17, 24, 39, 0.88);
}

.timeline-zoom-control {
  flex: 0 0 210px;
  min-width: 170px;
  display: flex;
  align-items: center;
  gap: 6px;
}

.timeline-zoom-slider {
  flex: 1 1 auto;
  min-width: 0;
}

.timeline-wrap {
  flex: 1 1 auto;
  min-height: 0;
  overflow: hidden;
}

.timeline-wrap.timeline-disabled {
  pointer-events: none;
  opacity: 0.72;
}

.timeline-editor-host {
  height: 100%;
}

.timeline-editor-host :deep(.timeline-editor) {
  height: 100%;
}

.timeline-action {
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  color: #fff;
}

.timeline-action-range {
  width: 100%;
  font-size: 12px;
  text-shadow: 0 1px 2px rgba(15, 23, 42, 0.45);
}

.timeline-action-processing-range {
  width: 100%;
  font-size: 12px;
  text-shadow: 0 1px 2px rgba(15, 23, 42, 0.45);
}

.timeline-editor-host :deep(.timeline-action.effect-effect-processing-range) {
  background: rgba(47, 179, 68, 0.86) !important;
  border-color: rgba(30, 130, 49, 0.88) !important;
}

.timeline-editor-host :deep(.timeline-action.effect-effect-processing-range.selected) {
  box-shadow: 0 0 0 2px rgba(47, 179, 68, 0.28) !important;
}

.timeline-action-keyframe {
  width: 100%;
  min-width: 14px;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
  position: relative;
}

.timeline-action-keyframe::before {
  content: "";
  position: absolute;
  left: 50%;
  top: 50%;
  width: 10px;
  height: 10px;
  background: #b4d0f9;
  border-radius: 1px;
  box-shadow: 0 0 0 1px rgba(104, 142, 196, 0.45);
  transform: translate(-50%, -50%) rotate(45deg);
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe) {
  top: 0;
  height: 100%;
  min-width: 14px;
  border: 0 !important;
  border-radius: 0;
  background: transparent !important;
  box-shadow: none !important;
  overflow: visible;
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe.selected) {
  border: 0 !important;
  background: transparent !important;
  box-shadow: none !important;
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe .timeline-action-content) {
  padding: 0;
  overflow: visible;
  display: flex;
  align-items: center;
  justify-content: center;
}

.keyframe-dot {
  display: none;
}

.timeline-editor-host :deep(.timeline-action.effect-effect-mask-keyframe.selected)
  .timeline-action-keyframe::before {
  box-shadow:
    0 0 0 1px rgba(104, 142, 196, 0.6),
    0 0 0 3px rgba(180, 208, 249, 0.28);
}

@media (max-width: 1280px) {
  .top-row {
    grid-template-columns: 280px 1fr 320px;
  }

  .timeline-controls-scroll {
    overflow-x: auto;
    overflow-y: hidden;
  }

  .timeline-controls-row {
    min-width: max-content;
  }
}

@media (max-width: 980px) {
  .timeline-progress-control {
    min-width: 260px;
  }
}
</style>

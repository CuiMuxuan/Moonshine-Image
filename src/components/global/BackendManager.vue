<template>
  <q-dialog v-model="showDialog" persistent class="backend-dialog">
    <q-card :class="['backend-manager-card', backendManagerCardClass]">
      <q-card-section class="row items-center q-pb-none bg-primary text-white">
        <q-icon name="settings" size="md" class="q-mr-sm" />
        <div class="text-h6">{{ backendManagerTitle }}</div>
        <q-space />
        <q-btn
          icon="close"
          flat
          round
          dense
          v-close-popup
          color="white"
          data-testid="backend-manager-close-button"
        />
      </q-card-section>

      <q-card-section class="q-pa-none backend-content">
        <q-splitter
          v-model="splitterModel"
          :limits="[20, 80]"
          :horizontal="$q.screen.lt.md"
          class="full-height"
        >
          <!-- 左侧控制面板 -->
          <template v-slot:before>
            <div :class="['q-pa-md', 'control-panel', 'full-height', controlPanelClass]">
              <q-stepper
                v-model="currentStep"
                vertical
                color="primary"
                animated
                header-nav
                class="backend-stepper bg-transparent"
              >
                <!-- 环境检测步骤 -->
                <q-step
                  :name="1"
                  title="环境检测"
                  icon="search"
                  :done="environmentCheckCompleted && environmentStatus.python && environmentStatus.project"
                  :error="environmentCheckCompleted && environmentStatus.error"
                  header-class="text-primary"
                  v-show="serviceStatus !== 'running'"
                >
                <div class="q-mb-md">
                  <div
                    class="q-pb-md"
                    data-testid="backend-python-environment-source-panel"
                  >
                    <div class="text-subtitle2 text-weight-medium q-mb-sm">Python 运行环境来源</div>
                    <q-btn-toggle
                      :model-value="pythonEnvironmentSource"
                      :options="pythonEnvironmentSourceOptions"
                      spread
                      no-caps
                      unelevated
                      toggle-color="primary"
                      toggle-text-color="white"
                      :color="$q.dark.isActive ? 'grey-9' : 'grey-3'"
                      :text-color="$q.dark.isActive ? 'grey-3' : 'primary'"
                      data-testid="backend-python-environment-source-toggle"
                      @update:model-value="handlePythonEnvironmentSourceChange"
                    />

                    <div
                      v-if="pythonEnvironmentSource === 'external'"
                      class="q-mt-md"
                      data-testid="backend-external-environment-panel"
                    >
                      <q-input
                        :model-value="externalEnvironmentPath"
                        outlined
                        dense
                        readonly
                        label="完整 Python 运行环境路径"
                        placeholder="尚未选择路径"
                        :hint="externalEnvironmentLayoutLabel"
                        data-testid="backend-external-environment-path"
                      >
                        <template #append>
                          <q-btn
                            flat
                            round
                            dense
                            icon="folder_open"
                            aria-label="选择已有 Python 运行环境路径"
                            :loading="updateManager.pendingExternalAction === 'select'"
                            :disable="updateManager.isExternalEnvironmentActionPending"
                            data-testid="backend-external-environment-select"
                            @click="handleSelectExternalEnvironment"
                          >
                            <q-tooltip>选择路径</q-tooltip>
                          </q-btn>
                        </template>
                      </q-input>

                      <div class="row items-center q-mt-md">
                        <q-btn
                          flat
                          round
                          dense
                          icon="help_outline"
                          :color="externalEnvironmentHelpColor"
                          aria-label="查看已有 Python 运行环境路径说明"
                          data-testid="backend-external-environment-help"
                          @click="externalEnvironmentHelpVisible = true"
                        >
                          <q-tooltip>查看路径选择说明</q-tooltip>
                        </q-btn>
                        <span class="text-caption text-grey-7">环境状态</span>
                        <q-space />
                        <q-badge
                          :color="externalEnvironmentStatusMeta.color"
                          data-testid="backend-external-environment-status"
                        >
                          {{ externalEnvironmentStatusMeta.label }}
                        </q-badge>
                      </div>

                      <q-banner
                        v-if="externalEnvironmentError"
                        rounded
                        class="bg-red-1 text-negative q-mt-sm"
                        data-testid="backend-external-environment-error"
                      >
                        {{ externalEnvironmentError }}
                      </q-banner>

                      <q-list
                        v-if="externalEnvironment.diagnostics"
                        dense
                        separator
                        class="q-mt-sm"
                        data-testid="backend-external-environment-diagnostics"
                      >
                        <q-item v-for="row in externalEnvironmentDiagnosticRows" :key="row.key">
                          <q-item-section avatar>
                            <q-icon
                              :name="getExternalDiagnosticIcon(row.state)"
                              :color="getExternalDiagnosticColor(row.state)"
                              size="sm"
                            />
                          </q-item-section>
                          <q-item-section>
                            <q-item-label>{{ row.label }}</q-item-label>
                            <q-item-label caption>{{ row.detail }}</q-item-label>
                          </q-item-section>
                        </q-item>
                      </q-list>

                      <div class="row justify-center q-gutter-sm q-mt-md">
                        <q-btn
                          v-if="externalEnvironmentPath"
                          flat
                          no-caps
                          color="primary"
                          icon="refresh"
                          label="重新校验"
                          :loading="updateManager.pendingExternalAction === 'probe'"
                          :disable="!externalEnvironmentCanProbe"
                          data-testid="backend-external-environment-probe"
                          @click="handleProbeExternalEnvironment"
                        />
                        <q-btn
                          v-if="externalEnvironmentPath && externalEnvironmentStatus !== 'active'"
                          flat
                          no-caps
                          color="grey-8"
                          icon="delete_outline"
                          label="忘记此路径"
                          :disable="updateManager.isExternalEnvironmentActionPending"
                          data-testid="backend-external-environment-forget"
                          @click="handleForgetExternalEnvironment"
                        />
                      </div>
                      <div v-if="externalEnvironmentStatus !== 'active'" class="row justify-center q-mt-sm">
                        <q-btn
                          color="primary"
                          no-caps
                          icon="check_circle"
                          label="使用此环境"
                          :loading="updateManager.pendingExternalAction === 'activate'"
                          :disable="!externalEnvironmentCanActivate"
                          data-testid="backend-external-environment-activate"
                          @click="handleActivateExternalEnvironment"
                        />
                      </div>
                      <div v-else class="row justify-center q-mt-sm">
                        <q-btn
                          outline
                          no-caps
                          color="warning"
                          icon="undo"
                          label="停止使用"
                          :loading="updateManager.pendingExternalAction === 'forget'"
                          :disable="updateManager.isExternalEnvironmentActionPending"
                          data-testid="backend-external-environment-return-managed"
                          @click="handleReturnToManagedEnvironment"
                        />
                      </div>
                    </div>

                    <q-dialog v-model="externalEnvironmentHelpVisible">
                      <q-card style="max-width: 560px">
                        <q-card-section class="row items-center q-pb-none">
                          <div class="text-subtitle1 text-weight-medium">已有 Python 运行环境路径说明</div>
                          <q-space />
                          <q-btn flat round dense icon="close" aria-label="关闭说明" v-close-popup />
                        </q-card-section>
                        <q-card-section class="text-body2 text-grey-8">
                          请选择完整的 Python 运行环境路径，不要选择 python.exe 或其他 EXE 文件。完整包请选择包含
                          runtime-manifest.json 的路径；Conda 环境请选择根路径（其中包含 python.exe）；venv
                          运行环境请选择包含 pyvenv.cfg 和 Scripts/python.exe 的路径。应用只会原地引用并校验该路径，不会复制或修改它。
                        </q-card-section>
                      </q-card>
                    </q-dialog>

                    <div
                      v-if="pythonEnvironmentSource === 'managed'"
                      class="q-mt-md"
                      data-testid="backend-managed-environment-panel"
                    >
                      <div class="row items-center">
                        <div>
                          <div class="text-subtitle2 text-weight-medium">自动管理运行环境</div>
                          <div class="text-caption text-grey-7">应用会在本机创建并校验所需运行环境</div>
                        </div>
                        <q-space />
                        <q-badge :color="managedEnvironmentStatusMeta.color" data-testid="backend-managed-environment-status">
                          {{ managedEnvironmentStatusMeta.label }}
                        </q-badge>
                      </div>
                      <q-select
                        v-model="managedAccelerator"
                        class="q-mt-md"
                        outlined
                        dense
                        emit-value
                        map-options
                        label="加速器"
                        :options="managedAcceleratorOptions"
                        :disable="managedEnvironmentBusy"
                        data-testid="backend-managed-environment-accelerator"
                        @update:model-value="handleManagedAcceleratorChange"
                      />
                      <q-linear-progress
                        v-if="managedEnvironmentProgress"
                        :indeterminate="managedEnvironmentProgressIndeterminate"
                        :value="Number(managedEnvironmentProgress.percent || 0) / 100"
                        color="primary"
                        rounded
                        class="q-mt-md"
                        data-testid="backend-managed-environment-progress"
                      />
                      <div v-if="managedEnvironmentProgress?.message" class="text-caption text-grey-7 q-mt-sm">
                        {{ managedEnvironmentProgress.message }}
                      </div>
                      <div
                        v-if="updateManager.runtimeState.activePath || updateManager.runtimeState.targetPath"
                        class="runtime-path-feedback q-mt-sm"
                        data-testid="backend-managed-environment-path"
                      >
                        <q-icon name="folder_open" size="16px" color="primary" />
                        <span class="text-caption text-grey-7">运行环境路径：</span>
                        <span class="text-caption runtime-path-feedback__value">
                          {{ updateManager.runtimeState.activePath || updateManager.runtimeState.targetPath }}
                        </span>
                        <q-tooltip>{{ updateManager.runtimeState.activePath || updateManager.runtimeState.targetPath }}</q-tooltip>
                      </div>
                      <q-banner
                        v-if="managedEnvironmentError"
                        rounded
                        class="bg-red-1 text-negative q-mt-sm"
                        data-testid="backend-managed-environment-error"
                      >
                        <div>{{ managedEnvironmentError }}</div>
                        <div class="q-mt-xs">请重试，或手动创建可用运行环境；也可以从夸克网盘下载可用运行环境，再在"已有环境"中选择。</div>
                      </q-banner>
                      <q-banner
                        v-if="updateManager.runtimeState.restartRequired"
                        rounded
                        inline-actions
                        class="bg-blue-1 text-grey-9 q-mt-sm"
                        data-testid="backend-managed-environment-restart-required"
                      >
                        运行环境已更新，重启应用后将使用新环境。
                        <template #action>
                          <q-btn
                            flat
                            no-caps
                            color="primary"
                            icon="restart_alt"
                            label="重启应用"
                            :disable="!updateManager.runtimeCanRestart"
                            @click="handleManagedEnvironmentRestart"
                          />
                        </template>
                      </q-banner>
                      <div v-if="!managedEnvironmentBusy" class="row justify-center q-gutter-sm q-mt-md">
                        <q-btn
                          outline
                          no-caps
                          color="primary"
                          icon="refresh"
                          label="检查环境"
                          data-testid="backend-managed-environment-check"
                          @click="checkEnvironment"
                        />
                        <q-btn
                          color="primary"
                          no-caps
                          icon="build"
                          label="创建或修复环境"
                          data-testid="backend-managed-environment-ensure"
                          @click="setupEnvironment"
                        />
                      </div>
                      <div v-else-if="updateManager.runtimeCanCancel || updateManager.runtimeState.status === 'cancelling'" class="row justify-center q-mt-md">
                        <q-btn
                          v-if="updateManager.runtimeCanCancel"
                          outline
                          no-caps
                          color="negative"
                          icon="stop_circle"
                          label="取消准备"
                          data-testid="backend-managed-environment-cancel"
                          @click="handleCancelManagedEnvironment"
                        />
                        <div v-else class="text-caption text-grey-7" data-testid="backend-managed-environment-cancelling">
                          正在取消并清理临时文件…
                        </div>
                      </div>
                    </div>
                  </div>

                  <q-list separator>
                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-spinner v-if="isEnvironmentItemChecking(primaryRuntimeItemKey)" color="primary" size="sm" />
                        <q-icon
                          v-else
                          :name="getEnvironmentItemIcon(primaryRuntimeItemKey)"
                          :color="getEnvironmentItemColor(primaryRuntimeItemKey)"
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >{{ pythonSectionLabel }}</q-item-label
                        >
                        <q-item-label data-testid="backend-environment-python-status" caption class="text-grey-6">{{
                          getEnvironmentItemLabel(
                            primaryRuntimeItemKey,
                            primaryRuntimeSuccessLabel,
                            primaryRuntimeFailureLabel
                          )
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>

                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-spinner v-if="isEnvironmentItemChecking('project')" color="primary" size="sm" />
                        <q-icon
                          v-else
                          :name="getEnvironmentItemIcon('project')"
                          :color="getEnvironmentItemColor('project')"
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >服务项目</q-item-label
                        >
                        <q-item-label data-testid="backend-environment-project-status" caption class="text-grey-6">{{
                          getEnvironmentItemLabel(
                            'project',
                            projectPath || '已检测到服务项目',
                            '未找到'
                          )
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>

                    <q-item v-if="!isBundledBackendMode" class="q-pa-sm">
                      <q-item-section avatar>
                        <q-spinner v-if="isEnvironmentItemChecking('venv')" color="primary" size="sm" />
                        <q-icon
                          v-else
                          :name="getEnvironmentItemIcon('venv')"
                          :color="getEnvironmentItemColor('venv')"
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium">虚拟环境</q-item-label>
                        <q-item-label data-testid="backend-environment-venv-status" caption class="text-grey-6">{{
                          getEnvironmentItemLabel(
                            'venv',
                            venvStatus || '已创建',
                            '未创建'
                          )
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>
                </div>

                <q-stepper-navigation v-if="!managedEnvironmentBusy" class="row justify-center">
                  <q-btn
                    @click="checkEnvironment"
                    color="primary"
                    label="重新检测"
                    unelevated
                    class="q-mb-sm"
                  />
                  <div class="q-gutter-sm">
                    <q-btn
                      v-if="
                        !isEnvironmentChecking &&
                        !isBundledBackendMode &&
                        environmentItemStates.python === 'failure'
                      "
                      @click="installPython"
                      color="secondary"
                      label="安装 Python"
                      :loading="installing.python"
                      outline
                      size="sm"
                    />
                    <q-btn
                      v-if="!isEnvironmentChecking && environmentItemStates.project === 'failure'"
                      @click="selectProjectPath"
                      color="secondary"
                      label="选择项目路径"
                      outline
                      size="sm"
                    />
                  </div>
                </q-stepper-navigation>
              </q-step>

              <!-- 环境配置步骤 -->
                <q-step
                  :name="2"
                  title="环境配置"
                  icon="build"
                  :done="environmentCheckCompleted && environmentStatus.configured"
                  :disable="isEnvironmentChecking || !environmentStatus.python || !environmentStatus.project"
                  header-class="text-primary"
                  v-show="serviceStatus !== 'running'"
                >
                <div class="q-mb-md">
                  <q-list separator>
                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-spinner v-if="isEnvironmentItemChecking('venv')" color="primary" size="sm" />
                        <q-icon
                          v-else
                          :name="getEnvironmentItemIcon('venv')"
                          :color="getEnvironmentItemColor('venv')"
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >{{ venvSetupLabel }}</q-item-label
                        >
                        <q-item-label data-testid="backend-environment-venv-setup-status" caption class="text-grey-6">{{
                          getEnvironmentItemLabel('venv', venvStatus || '已创建', '未创建')
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>

                    <q-item class="q-pa-sm">
                      <q-item-section avatar>
                        <q-spinner v-if="isEnvironmentItemChecking('dependencies')" color="primary" size="sm" />
                        <q-icon
                          v-else
                          :name="getEnvironmentItemIcon('dependencies')"
                          :color="getEnvironmentItemColor('dependencies')"
                          size="sm"
                        />
                      </q-item-section>
                      <q-item-section>
                        <q-item-label class="text-weight-medium"
                          >{{ dependenciesLabel }}</q-item-label
                        >
                        <q-item-label data-testid="backend-environment-dependencies-status" caption class="text-grey-6">{{
                          getEnvironmentItemLabel(
                            'dependencies',
                            dependenciesStatus || '已就绪',
                            dependenciesStatus || '未安装'
                          )
                        }}</q-item-label>
                      </q-item-section>
                    </q-item>
                  </q-list>

                  <q-linear-progress
                    v-if="installing.dependencies"
                    :value="installProgress"
                    color="primary"
                    class="q-mt-md"
                    rounded
                    size="8px"
                  />
                </div>

                <q-stepper-navigation v-if="!managedEnvironmentBusy" class="row justify-center">
                  <q-btn
                    @click="setupEnvironment"
                    color="primary"
                    :label="setupEnvironmentLabel"
                    :loading="installing.dependencies"
                    :disable="
                      isEnvironmentChecking || !environmentStatus.python || !environmentStatus.project
                    "
                    unelevated
                  >
                    <template #loading>
                      <q-spinner :color="$q.dark.isActive ? 'dark' : 'white'" />
                    </template>
                  </q-btn>
                </q-stepper-navigation>
              </q-step>

              <!-- 服务管理步骤 -->
                <q-step
                  :name="3"
                  title="服务管理"
                  icon="play_arrow"
                  :disable="!canUseServiceManagementStep"
                  header-class="text-primary"
                >
                <div class="service-management-panel">
                  <section class="service-overview" aria-label="服务状态">
                    <div class="service-overview__header">
                      <div class="text-subtitle2 text-weight-medium">服务状态</div>
                      <q-chip
                        :color="
                          serviceStatus === 'running'
                            ? 'positive'
                            : ['stopped', 'failed'].includes(serviceStatus)
                            ? 'negative'
                            : 'orange'
                        "
                        text-color="white"
                        :icon="
                          serviceStatus === 'running'
                            ? 'play_arrow'
                            : ['stopped', 'failed'].includes(serviceStatus)
                            ? 'stop'
                            : 'pending'
                        "
                        class="service-status-chip"
                      >
                        {{ serviceStatusText }}
                      </q-chip>
                    </div>

                    <dl class="service-info-grid">
                      <div class="service-info-item"><dt>端口</dt><dd>{{ backendConfig.port }}</dd></div>
                      <div class="service-info-item"><dt>设备</dt><dd>{{ backendConfig.device }}</dd></div>
                      <div class="service-info-item"><dt>当前模型</dt><dd>{{ backendConfig.model }}</dd></div>
                      <div class="service-info-item"><dt>模型路径</dt><dd :title="backendModelLocation">{{ backendModelLocation || "未配置" }}</dd></div>
                    </dl>

                      <q-banner
                        v-if="backendEngineStore.error || activeDiagnostic"
                        rounded
                        class="q-mt-md bg-red-1 text-negative"
                        role="alert"
                      >
                        <template #avatar>
                          <q-icon name="error_outline" color="negative" />
                        </template>
                        <div class="text-weight-medium">
                          {{ backendEngineStore.error || activeDiagnostic?.reason || '服务启动失败' }}
                        </div>
                        <div
                          v-if="backendEngineStore.recoveryHint"
                          class="q-mt-xs text-body2 text-grey-9"
                        >
                          {{ backendEngineStore.recoveryHint }}
                        </div>
                        <q-expansion-item
                          v-if="diagnosticRows.length || activeDiagnostic?.stdoutTail || activeDiagnostic?.stderrTail"
                          dense
                          dense-toggle
                          icon="troubleshoot"
                          label="诊断详情"
                          class="q-mt-sm diagnostic-expansion"
                        >
                          <q-list dense separator>
                            <q-item v-for="([label, detail], index) in diagnosticRows" :key="index">
                              <q-item-section side class="text-grey-8">{{ label }}</q-item-section>
                              <q-item-section class="diagnostic-value">{{ detail }}</q-item-section>
                            </q-item>
                          </q-list>
                          <pre
                            v-if="activeDiagnostic?.stderrTail"
                            class="diagnostic-output q-mt-sm"
                          >{{ activeDiagnostic.stderrTail }}</pre>
                          <pre
                            v-if="activeDiagnostic?.stdoutTail"
                            class="diagnostic-output q-mt-sm"
                          >{{ activeDiagnostic.stdoutTail }}</pre>
                        </q-expansion-item>
                      </q-banner>
                  </section>

                  <section class="service-configuration" aria-label="启动配置">
                      <div class="text-subtitle2 text-weight-medium q-mb-sm">启动配置</div>
                      <q-form class="service-config-grid">
                        <q-input
                          v-model.number="backendConfig.port"
                          label="端口"
                          type="number"
                          :min="1024"
                          :max="65535"
                          dense
                          outlined
                          color="primary"
                        />

                        <q-select
                          v-model="backendConfig.device"
                          :options="deviceOptions"
                          label="设备"
                          dense
                          outlined
                          color="primary"
                        />

                        <q-select
                          v-model="backendConfig.model"
                          :options="modelOptions"
                          label="模型"
                          emit-value
                          map-options
                          dense
                          outlined
                          color="primary"
                        />
                        <q-banner
                          v-if="isBundledBackendMode"
                          dense
                          rounded
                          class="model-management-notice"
                        >
                          <div class="model-management-notice__content">
                            <span>请打开模型管理页下载所需模型</span>
                            <q-btn
                              flat
                              dense
                              no-caps
                              color="primary"
                              icon="model_training"
                              label="打开模型管理"
                              @click="openModelManagement"
                            />
                          </div>
                        </q-banner>
                        <q-input
                          v-else
                          v-model="backendConfig.modelDir"
                          label="模型路径"
                          dense
                          outlined
                          color="primary"
                          placeholder="可选：指定模型文件存储路径"
                          hint="留空则使用默认路径"
                        >
                          <template v-slot:append>
                            <q-btn
                              flat
                              round
                              dense
                              icon="folder"
                              @click="selectModelDir"
                              color="primary"
                            />
                          </template>
                        </q-input>
                      </q-form>
                      <div
                        :class="[
                          'service-controls',
                          { 'service-controls--single': serviceStatus !== 'running' },
                        ]"
                        aria-label="服务操作"
                        data-testid="backend-service-controls"
                      >
                        <q-btn
                          v-if="serviceStatus !== 'running'"
                          @click="startService"
                          color="positive"
                          icon="play_arrow"
                          :label="serviceStartButtonLabel"
                          :loading="serviceLoading || serviceStatus === 'starting'"
                          :disable="!['stopped', 'failed'].includes(serviceStatus)"
                          class="service-control-button"
                          data-testid="backend-start-service-button"
                          unelevated
                          no-caps
                        />
                        <q-btn
                          v-if="serviceStatus === 'running'"
                          @click="stopService"
                          color="negative"
                          icon="stop"
                          label="停止服务"
                          :loading="serviceLoading"
                          class="service-control-button"
                          data-testid="backend-stop-service-button"
                          unelevated
                          no-caps
                        />
                        <q-btn
                          v-if="serviceStatus === 'running'"
                          @click="restartService"
                          color="orange"
                          icon="refresh"
                          label="重启服务"
                          :loading="serviceLoading"
                          class="service-control-button"
                          data-testid="backend-restart-service-button"
                          outline
                          no-caps
                        />
                      </div>
                  </section>
                </div>
              </q-step>
            </q-stepper>
          </div>

          </template>

          <!-- 右侧终端区域 -->
          <template v-slot:after>
            <div class="terminal-section full-height">
              <div class="terminal-header">
                <q-icon name="terminal" class="q-mr-sm" />
                <span class="text-h6">终端输出</span>
                <q-space />
                <q-btn
                  v-if="activeDiagnostic"
                  flat
                  round
                  dense
                  icon="content_copy"
                  color="white"
                  aria-label="复制启动诊断"
                  @click="copyStartupDiagnostic"
                >
                  <q-tooltip>复制启动诊断</q-tooltip>
                </q-btn>
                <q-btn
                  flat
                  round
                  dense
                  icon="folder_open"
                  color="white"
                  aria-label="打开启动日志"
                  @click="openStartupLog"
                >
                  <q-tooltip>打开启动日志</q-tooltip>
                </q-btn>
                <q-btn
                  flat
                  round
                  dense
                  icon="clear_all"
                  color="white"
                  @click="clearTerminal"
                  class="q-mr-sm"
                >
                  <q-tooltip>清空终端</q-tooltip>
                </q-btn>
              </div>
              <div ref="terminalRef" class="terminal-output" data-testid="backend-terminal-output">
                <div
                  v-for="(line, index) in terminalOutput"
                  :key="index"
                  :class="['terminal-line', getTerminalLineClass(line)]"
                  data-testid="backend-terminal-line"
                  :data-refresh-id="line.refreshId"
                >
                  <span class="text-grey-5">[{{ line.timestamp }}]</span>
                  {{ line.message }}
                </div>
              </div>

              <!-- 终端输入 -->
              <div class="terminal-input">
                <q-input
                  v-model="terminalInput"
                  dense
                  outlined
                  placeholder="输入命令..."
                  class="col"
                  bg-color="grey-9"
                  color="green"
                  @keyup.enter="executeCommand"
                >
                  <template v-slot:prepend>
                    <q-icon name="terminal" color="green" />
                  </template>
                </q-input>
                <q-btn
                  @click="executeCommand"
                  color="primary"
                  icon="send"
                  dense
                  class="q-ml-sm"
                  :loading="commandExecuting"
                  unelevated
                >
                  <template #loading>
                    <q-spinner :color="$q.dark.isActive ? 'dark' : 'white'" />
                  </template>
                </q-btn>
              </div>
            </div>
          </template>
        </q-splitter>
      </q-card-section>
    </q-card>
  </q-dialog>
</template>
<script setup>
import { computed, inject, ref, reactive, onMounted, onUnmounted, nextTick, watch } from "vue";
import { copyToClipboard, useQuasar } from "quasar";
import { useConfigStore } from "src/stores/config";
import { useBackendEngineStore } from "src/stores/backendEngine";
import { useModelRegistryStore } from "src/stores/modelRegistry";
import { useUpdateManagerStore } from "src/stores/updateManager";
import { api } from "src/boot/axios";
import {
  buildBackendPathBlockedMessage,
  buildBackendPathWarningMessage,
  buildBackendPathSelectionBlockedMessage,
  validateBackendPaths,
} from "src/utils/backendPathValidation";
import {
  BACKEND_ENVIRONMENT_ITEM_KEYS,
  finalizeEnvironmentItemStates,
  mapEnvironmentFailureToItems,
  resolveEnvironmentItemGroupState,
} from "src/utils/backendEnvironmentStatus";

// Props
const props = defineProps({
  modelValue: {
    type: Boolean,
    default: false,
  },
});
const splitterModel = ref(35);

const configStore = useConfigStore();
const backendEngineStore = useBackendEngineStore();
const modelRegistryStore = useModelRegistryStore();
const updateManager = useUpdateManagerStore();
const $q = useQuasar();
// Emits
const emit = defineEmits(["update:modelValue"]);

const backendEngineActions = inject("backendEngine", ref({}));
const globalSettings = inject("globalSettings", null);
const loadingControl = inject("loadingControl", null);
const readInjectedValue = (value) => value?.value ?? value;
const getBackendEngineAction = (name) => {
  const actions = readInjectedValue(backendEngineActions) || {};
  return typeof actions[name] === "function" ? actions[name] : null;
};
const openModelManagement = () => {
  globalSettings?.open?.({ tab: "models", modelId: backendConfig.model || "" });
  showDialog.value = false;
};
const observedBackendRunning = computed(() => backendEngineStore.isRunning);
const isBackendPreparing = computed(() => backendEngineStore.isPreparing);

const backendMode = ref("external");
const isBundledBackendMode = computed(() => backendMode.value === "bundled");
const backendManagerTitle = computed(() =>
  isBundledBackendMode.value ? "服务管理" : "Python 服务管理"
);
const pythonSectionLabel = computed(() =>
  isBundledBackendMode.value ? "本地运行环境" : "Python 环境"
);
const primaryRuntimeItemKey = computed(() =>
  isBundledBackendMode.value ? "runtime" : "python"
);
const primaryRuntimeSuccessLabel = computed(() =>
  isBundledBackendMode.value
    ? pythonVersion.value || "已就绪"
    : pythonVersion.value || "已检测到 Python"
);
const primaryRuntimeFailureLabel = computed(() =>
  isBundledBackendMode.value ? "未就绪" : "未检测到"
);
const venvSetupLabel = computed(() =>
  isBundledBackendMode.value ? "运行环境准备" : "虚拟环境创建"
);
const dependenciesLabel = computed(() =>
  isBundledBackendMode.value ? "内置依赖" : "依赖安装"
);
const setupEnvironmentLabel = computed(() =>
  isBundledBackendMode.value ? "准备运行环境" : "配置环境"
);
const pythonEnvironmentSource = ref("managed");
const pythonEnvironmentSourceOptions = [
  { label: "自动管理", value: "managed" },
  { label: "已有环境", value: "external" },
];
const normalizeRuntimeAccelerator = (value) => {
  const accelerator = String(value || "").trim().toLowerCase();
  return ["auto", "cpu", "cu130"].includes(accelerator) ? accelerator : "auto";
};
const externalEnvironmentHelpVisible = ref(false);
const externalEnvironment = computed(() =>
  updateManager.runtimeState.external || {}
);
const externalEnvironmentPath = computed(() =>
  externalEnvironment.value.selectedPath ||
  externalEnvironment.value.path ||
  externalEnvironment.value.directory ||
  ""
);
const normalizeExternalEnvironmentStatus = (value) => ({
  idle: "unselected",
  selected: "stale",
  "needs-probe": "stale",
  "needs-reprobe": "stale",
  checking: "probing",
  ready: updateManager.runtimeState.source === "external" ? "active" : "valid",
  failed: "invalid",
}[value] || value || "unselected");
const externalEnvironmentStatus = computed(() => {
  if (
    updateManager.runtimeState.source === "external" &&
    !["probing", "invalid", "stale"].includes(externalEnvironment.value.status)
  ) {
    return "active";
  }
  if (!externalEnvironmentPath.value && !externalEnvironment.value.candidateId) {
    return "unselected";
  }
  return normalizeExternalEnvironmentStatus(externalEnvironment.value.status);
});
const externalEnvironmentStatusMeta = computed(() => ({
  unselected: { label: "未选择", color: "grey-7" },
  probing: { label: "校验中", color: "primary" },
  valid: { label: "可使用", color: "positive" },
  active: { label: "使用中", color: "positive" },
  stale: { label: "需要重新校验", color: "warning" },
  invalid: { label: "不可用", color: "negative" },
}[externalEnvironmentStatus.value] || { label: "未选择", color: "grey-7" }));
const externalEnvironmentHelpColor = computed(() =>
  externalEnvironmentStatus.value === "invalid" ? "negative" : "info"
);
const externalEnvironmentLayoutLabel = computed(() => ({
  "runtime-manifest": "完整包运行环境",
  conda: "Conda 运行环境",
  venv: "venv 运行环境",
}[externalEnvironment.value.layout] || externalEnvironment.value.layout || ""));
const externalEnvironmentError = computed(() => {
  const error = externalEnvironment.value.error;
  if (!error) return "";
  return String(error.message || error.reason || error);
});
const readDiagnosticState = (value) => {
  if (value === true) return "success";
  if (value === false) return "failure";
  const status = String(value?.status || "").toLowerCase();
  if (["pass", "passed", "success", "ready", "ok", "valid"].includes(status)) return "success";
  if (["fail", "failed", "error", "invalid", "unavailable"].includes(status)) return "failure";
  if (value?.success === true || value?.ok === true || value?.passed === true) return "success";
  if (value?.success === false || value?.ok === false || value?.passed === false) return "failure";
  return "idle";
};
const readDiagnosticDetail = (value, fallback = "等待校验") => {
  if (value === true) return "通过";
  if (value === false) return "未通过";
  if (typeof value === "string" || typeof value === "number") return String(value);
  const parts = [
    value?.version,
    value?.bits ? `${value.bits} 位` : null,
    value?.architecture || value?.arch,
    value?.build,
    value?.type || value?.accelerator,
    value?.module,
    value?.deviceName || value?.device,
    value?.message || value?.reason,
  ].filter(Boolean);
  return parts.length ? [...new Set(parts.map(String))].join(" · ") : fallback;
};
const externalEnvironmentDiagnosticRows = computed(() => {
  const diagnostics = externalEnvironment.value.diagnostics || {};
  const accelerator =
    externalEnvironment.value.accelerator ||
    diagnostics.accelerator?.type ||
    diagnostics.accelerator ||
    null;
  const cudaDiagnostic = diagnostics.cuda
    ? {
      ...diagnostics.cuda,
      message:
        diagnostics.cuda.message ||
        (diagnostics.cuda.available === false && accelerator === "cpu"
          ? "CPU 环境，无需 CUDA"
          : null),
    }
    : null;
  const definitions = [
    ["python", "Python", diagnostics.python],
    ["torch", "PyTorch", diagnostics.torch || diagnostics.pytorch],
    ["accelerator", "加速类型", accelerator ? { ok: true, type: accelerator } : null],
    ["cuda", "CUDA", cudaDiagnostic],
    ["backend", "后端模块", diagnostics.backend],
    ["ffmpeg", "应用内置 FFmpeg", diagnostics.ffmpeg || diagnostics.bundledFfmpeg],
  ];
  return definitions.map(([key, label, value]) => ({
    key,
    label,
    state: readDiagnosticState(value),
    detail: readDiagnosticDetail(value),
  }));
});
const getExternalDiagnosticIcon = (state) => ({
  success: "check_circle",
  failure: "error",
  idle: "radio_button_unchecked",
}[state] || "radio_button_unchecked");
const getExternalDiagnosticColor = (state) => ({
  success: "positive",
  failure: "negative",
  idle: "grey-6",
}[state] || "grey-6");
const externalEnvironmentCanProbe = computed(() =>
  Boolean(externalEnvironment.value.candidateId) &&
  !updateManager.isExternalEnvironmentActionPending
);
const externalEnvironmentCanActivate = computed(() =>
  externalEnvironmentStatus.value === "valid" &&
  externalEnvironment.value.canActivate === true &&
  !updateManager.isExternalEnvironmentActionPending
);
const managedAccelerator = ref(
  normalizeRuntimeAccelerator(
    updateManager.runtimeState.preference || "auto"
  )
);
const managedAcceleratorOptions = [
  { label: "自动（推荐）", value: "auto" },
  { label: "CPU", value: "cpu" },
  { label: "NVIDIA cu130", value: "cu130" },
];
const managedEnvironmentProgress = computed(() => updateManager.runtimeState.progress || null);
const managedEnvironmentProgressIndeterminate = computed(() => {
  const progress = managedEnvironmentProgress.value;
  if (!progress || ["complete", "failed", "cancelled"].includes(progress.status)) return false;
  return !Number.isFinite(Number(progress.percent));
});
const managedEnvironmentBusy = computed(() =>
  checking.value ||
  installing.dependencies ||
  updateManager.isRuntimeActionPending ||
  ["preparing", "creating", "repairing", "downloading", "verifying", "cancelling"].includes(updateManager.runtimeState.status)
);
const managedEnvironmentError = computed(() => {
  const error = updateManager.runtimeState.error;
  return error ? String(error.message || error.reason || error) : "";
});
const managedEnvironmentStatusMeta = computed(() => {
  const state = updateManager.runtimeState;
  const phase = String(state.progress?.phase || "");
  if (["preparing", "creating", "repairing", "downloading", "verifying", "cancelling"].includes(state.status)) {
    if (state.status === "cancelling") return { label: "正在取消", color: "warning" };
    if (phase === "python-download") return { label: "正在下载 Python", color: "primary" };
    if (["python-install", "python-verify", "python-discovery", "python-ready"].includes(phase)) {
      return { label: "正在自动安装", color: "primary" };
    }
    return { label: "正在准备环境", color: "primary" };
  }
  if (["needs-create", "needs-download", "idle"].includes(state.status)) {
    return { label: "未检测到运行环境", color: "grey-7" };
  }
  if (["failed", "needs-repair"].includes(state.status)) return { label: "需要修复", color: "negative" };
  if (state.status === "degraded") return { label: "环境可用，视频受限", color: "warning" };
  if (state.status === "ready") return { label: "环境就绪", color: "positive" };
  return { label: updateManager.runtimeStatusLabel || "尚未检测", color: "grey-7" };
});
const handleManagedAcceleratorChange = async (value) => {
  const result = await updateManager.setRuntimeChannel(value);
  if (result?.success === false) {
    managedAccelerator.value = normalizeRuntimeAccelerator(
      updateManager.runtimeState.preference || "auto"
    );
    notifyExternalEnvironmentFailure(result, "保存加速器选择失败。");
    return;
  }
  addTerminalLog(`已选择${managedAcceleratorOptions.find((item) => item.value === value)?.label || "自动"}，下次创建环境时生效。`, "info");
};
const handleManagedEnvironmentRestart = () => {
  $q.dialog({
    title: "运行环境已准备完成",
    message: "重启 Moonshine-Image 后将使用新环境。请先保存尚未导出的内容。",
    cancel: { flat: true, label: "稍后重启" },
    ok: { color: "primary", label: "立即重启" },
    persistent: true,
  }).onOk(async () => {
    const result = await updateManager.restartApplication();
    if (result?.success === false) notifyExternalEnvironmentFailure(result, "重启应用失败。");
  });
};
const handleCancelManagedEnvironment = () => {
  $q.dialog({
    title: "取消运行环境准备",
    message: "将停止当前下载或安装并清理临时文件。已经启用的运行环境不会受到影响。",
    cancel: { flat: true, label: "继续准备" },
    ok: { color: "negative", label: "取消准备" },
    persistent: true,
  }).onOk(async () => {
    const result = await updateManager.cancelEnvironmentPreparation();
    if (result?.success === false) {
      notifyExternalEnvironmentFailure(result, "取消运行环境准备失败。");
      return;
    }
    addTerminalLog("正在取消运行环境准备并清理临时文件。", "warning");
  });
};
const notifyExternalEnvironmentFailure = (result, fallbackMessage) => {
  if (result?.success !== false) return false;
  const message =
    result?.error?.message ||
    result?.message ||
    result?.reason ||
    result?.error ||
    fallbackMessage;
  $q.notify({ type: "negative", message, position: "top", timeout: 5000 });
  return true;
};
const withGlobalLoading = async (message, action) => {
  loadingControl?.show?.(message);
  try {
    return await action();
  } finally {
    loadingControl?.hide?.();
  }
};
const markExternalEnvironmentUnavailable = (message) => {
  const error = {
    code: "EXTERNAL_ENV_FULL_CHECK_FAILED",
    message,
  };
  updateManager.applyRuntimeState({
    source: "external",
    status: "failed",
    error,
    external: {
      ...externalEnvironment.value,
      status: "invalid",
      canActivate: false,
      error,
    },
  });
};
const handleProbeExternalEnvironment = async () => {
  const result = await withGlobalLoading("正在校验已有 Python 环境…", () =>
    updateManager.probeExternalEnvironment({
      candidateId: externalEnvironment.value.candidateId,
    })
  );
  if (notifyExternalEnvironmentFailure(result, "已有 Python 环境校验失败。")) return result;
  if (result?.valid === false || externalEnvironmentStatus.value === "invalid") {
    $q.notify({ type: "warning", message: "该路径未通过完整环境校验。", position: "top" });
    return result;
  }
  $q.notify({ type: "positive", message: "环境校验通过，可以使用。", position: "top" });
  return result;
};
const handleSelectExternalEnvironment = async () => {
  pythonEnvironmentSource.value = "external";
  const result = await updateManager.selectExternalEnvironmentDirectory();
  if (result?.cancelled || result?.canceled) return;
  if (notifyExternalEnvironmentFailure(result, "选择 Python 运行环境路径失败。")) return;
  if (!externalEnvironment.value.candidateId) {
    $q.notify({
      type: "negative",
      message: "主进程未返回可校验的运行环境路径，请重新选择。",
      position: "top",
    });
    return;
  }
  await handleProbeExternalEnvironment();
};
const handleActivateExternalEnvironment = async () => {
  const result = await updateManager.activateExternalEnvironment({
    candidateId: externalEnvironment.value.candidateId,
  });
  if (notifyExternalEnvironmentFailure(result, "启用已有 Python 环境失败。")) return;
  pythonEnvironmentSource.value = "external";
  addTerminalLog("已切换到用户选择的 Python 环境，正在重新检测服务环境。", "info");
  await withGlobalLoading("正在重新检测所选 Python 环境…", () =>
    checkEnvironment({ syncServiceStatus: true })
  );

  if (!environmentStatus.configured) {
    const message = "完整环境检测未通过；已保留所选 Python 环境，但当前标记为不可用。";
    markExternalEnvironmentUnavailable(message);
    addTerminalLog(message, "warning");
    $q.notify({ type: "warning", message, position: "top", timeout: 5000 });
    return result;
  }

  addTerminalLog("已切换到用户选择的 Python 环境。", "success");
  $q.notify({ type: "positive", message: "已开始使用此 Python 环境。", position: "top" });
  return result;
};
const performForgetExternalEnvironment = async ({ returnToManaged = false } = {}) => {
  const result = returnToManaged
    ? await updateManager.returnToManagedEnvironment()
    : await updateManager.forgetExternalEnvironment();
  if (notifyExternalEnvironmentFailure(result, "恢复自动管理失败。")) return;
  pythonEnvironmentSource.value = "managed";
  addTerminalLog("已恢复自动管理的 Python 运行环境；外部路径未被修改。", "info");
  $q.notify({ type: "positive", message: "已恢复自动管理，外部路径未被修改。", position: "top" });
};
const handleForgetExternalEnvironment = () => {
  void performForgetExternalEnvironment();
};
const handleReturnToManagedEnvironment = () => {
  $q.dialog({
    title: "停止使用已有环境",
    message: "应用将恢复自动管理的运行环境。所选路径及其文件不会被删除或修改。",
    cancel: { flat: true, label: "取消" },
    ok: { color: "primary", label: "恢复自动管理" },
  }).onOk(() => {
    void performForgetExternalEnvironment({ returnToManaged: true });
  });
};
const handlePythonEnvironmentSourceChange = (source) => {
  if (source === "external") {
    pythonEnvironmentSource.value = "external";
    return;
  }
  if (updateManager.runtimeState.source === "external") {
    handleReturnToManagedEnvironment();
    return;
  }
  pythonEnvironmentSource.value = "managed";
};
watch(
  () => [
    updateManager.runtimeState.source,
    updateManager.runtimeState.external?.status,
    updateManager.runtimeState.external?.candidateId,
  ],
  ([source, status]) => {
    if (source === "external" || status === "active") {
      pythonEnvironmentSource.value = "external";
      return;
    }
    // Keep the user's explicit "已有环境" choice visible even when probing
    // failed and the opaque candidate token is temporarily unavailable.
  },
  { immediate: true }
);
watch(
  () => updateManager.runtimeState.preference,
  (value) => {
    if (value) managedAccelerator.value = normalizeRuntimeAccelerator(value);
  }
);

// 响应式数据
const backendManagerCardClass = computed(() =>
  $q.dark.isActive ? "backend-manager-card--dark" : "backend-manager-card--light"
);
const controlPanelClass = computed(() =>
  $q.dark.isActive ? "control-panel--dark" : "control-panel--light"
);
const backendModelLocation = computed(() =>
  backendConfig.modelDir || (isBundledBackendMode.value ? "resources/models" : "")
);
const showDialog = ref(props.modelValue);
const currentStep = ref(1);
const checking = ref(false);
const environmentCheckCompleted = ref(false);
const commandExecuting = ref(false);
const serviceLoading = ref(false);
let serviceProcessPollTimerId = 0;
let removeBackendOutputListener = null;
let removePythonInstallPathListener = null;
let environmentCheckPromise = null;

// 环境状态
const environmentStatus = reactive({
  python: false,
  project: false,
  venv: false,
  dependencies: false,
  configured: false,
  error: false,
});
const ENVIRONMENT_ITEM_KEYS = BACKEND_ENVIRONMENT_ITEM_KEYS;
const environmentItemStates = reactive({
  python: "idle",
  project: "idle",
  venv: "idle",
  dependencies: "idle",
});
const setEnvironmentItemState = (items, state) => {
  const keys = Array.isArray(items) ? items : [items];
  keys.forEach((item) => {
    if (ENVIRONMENT_ITEM_KEYS.includes(item)) {
      environmentItemStates[item] = state;
    }
  });
};
const setAllEnvironmentItemStates = (state) =>
  setEnvironmentItemState(ENVIRONMENT_ITEM_KEYS, state);
const getEnvironmentItemState = (item) => {
  if (item === "runtime" && isBundledBackendMode.value) {
    if (pythonEnvironmentSource.value === "managed") {
      const status = updateManager.runtimeState.status;
      if (status === "degraded") return "blocked";
      if (status === "ready") return "success";
      if (["failed", "needs-repair"].includes(status)) return "failure";
    }
    if (pythonEnvironmentSource.value === "external") {
      const status = updateManager.runtimeState.status;
      if (status === "degraded") return "blocked";
      if (status === "ready") return "success";
      if (["failed", "needs-repair"].includes(status)) return "failure";
    }
  }
  return item === "runtime"
    ? resolveEnvironmentItemGroupState(environmentItemStates, ["python", "venv"])
    : environmentItemStates[item] || "idle";
};
const isEnvironmentItemChecking = (item) =>
  (item === "runtime" && pythonEnvironmentSource.value === "managed" && managedEnvironmentBusy.value) ||
  getEnvironmentItemState(item) === "checking";
const getEnvironmentItemIcon = (item) => {
  const state = getEnvironmentItemState(item);
  if (state === "success") return "check_circle";
  if (state === "failure") return "error";
  if (state === "blocked") return "warning";
  return "pending";
};
const getEnvironmentItemColor = (item) => {
  const state = getEnvironmentItemState(item);
  if (state === "success") return "positive";
  if (state === "failure") return "negative";
  if (state === "blocked") return "warning";
  return "grey-6";
};
const getEnvironmentItemLabel = (item, successLabel, failureLabel) => {
  if (item === "runtime" && isBundledBackendMode.value) {
    if (pythonEnvironmentSource.value === "managed") {
      return managedEnvironmentStatusMeta.value.label;
    }
    if (pythonEnvironmentSource.value === "external") {
      return externalEnvironmentStatusMeta.value.label;
    }
  }
  const state = getEnvironmentItemState(item);
  if (state === "checking") return "正在检测";
  if (state === "success") return successLabel;
  if (state === "failure") return failureLabel;
  if (state === "blocked") return "前置检测未通过";
  return "尚未检测";
};
const resetEnvironmentStatusForCheck = () => {
  environmentStatus.python = false;
  environmentStatus.project = false;
  environmentStatus.venv = false;
  environmentStatus.dependencies = false;
  environmentStatus.configured = false;
};
const finishUncheckedEnvironmentItems = () => {
  Object.assign(
    environmentItemStates,
    finalizeEnvironmentItemStates(environmentItemStates)
  );
};
const applyEnvironmentFailureState = (failure, stage) => {
  const completedItems = ENVIRONMENT_ITEM_KEYS.filter(
    (item) => environmentItemStates[item] === "success"
  );
  const mapped = mapEnvironmentFailureToItems(
    failure && typeof failure === "object"
      ? failure
      : { error: String(failure || "未知错误") },
    {
      completedItems,
      lifecycleStage: stage,
    }
  );
  Object.assign(environmentItemStates, mapped.states);
  return mapped;
};
const isEnvironmentChecking = computed(
  () => checking.value || !environmentCheckCompleted.value
);

// 安装状态
const installing = reactive({
  python: false,
  dependencies: false,
});

// 服务状态
const serviceStatus = computed(() => {
  if (backendEngineStore.status === "preparing") return "starting";
  if (backendEngineStore.status === "idle") return "stopped";
  return backendEngineStore.status;
});
const serviceStatusText = computed(() => ({
  starting: "等待接口就绪",
  running: "运行中",
  stopping: "停止中",
  stopped: "已停止",
  failed: "启动失败",
}[serviceStatus.value] || "已停止"));
const canUseServiceManagementStep = computed(
  () =>
    environmentStatus.configured ||
    backendEngineStore.hasFailed ||
    ["starting", "running", "stopping"].includes(serviceStatus.value)
);
const serviceStartButtonLabel = computed(() =>
  serviceStatus.value === "starting" ? "等待接口就绪" : "启动服务"
);
const activeDiagnostic = computed(() => backendEngineStore.diagnostic || null);
const diagnosticRows = computed(() => {
  const value = activeDiagnostic.value;
  if (!value) return [];
  return [
    ["诊断编号", value.id],
    ["错误代码", value.code],
    ["阶段", value.stage],
    ["命令", value.commandLine],
    ["工作路径", value.cwd],
    ["系统错误", value.osCode],
    ["退出码", value.exitCode],
    ["信号", value.signal],
    ["日志", value.logPath],
  ].filter(([, detail]) => detail !== undefined && detail !== null && detail !== "");
});

// 配置
const pythonVersion = ref("");
const projectPath = ref("");
const venvStatus = ref("未创建");
const dependenciesStatus = ref("未安装");
const installProgress = ref(0);

// 后端配置
const backendConfig = reactive({
  port: configStore.config.general.backendPort || 8080,
  device: configStore.config.general.launchMode || "cuda",
  model: configStore.config.general.defaultModel || "lama",
  projectPath: configStore.config.general.backendProjectPath || "",
  modelDir: configStore.config.general.modelDir || "",
  samReleaseBeforeProcessing:
    configStore.config.masking?.samReleaseBeforeProcessing !== false,
});

// 选项
const deviceOptions = ["cuda", "cpu"];
const MAT_CUDA_FALLBACK_MESSAGE = "MAT 需要 CUDA，当前已自动切换为 LaMa。";
const backendModelOptions = [
  { label: "LaMa", value: "lama" },
  { label: "MAT", value: "mat" },
];
const modelOptions = computed(() =>
  backendModelOptions.map((option) => ({
    ...option,
    disable: option.value === "mat" && backendConfig.device !== "cuda",
  }))
);

// 终端
const terminalOutput = ref([]);
const terminalInput = ref("");
const terminalRef = ref(null);
const MAX_TERMINAL_LINES = 2000;
const TERMINAL_PROGRESS_SYNC_MIN_MS = 500;
const TERMINAL_PROGRESS_SYNC_MAX_MS = 1000;
const TERMINAL_PROGRESS_HEARTBEAT_MS = 1000;
const TERMINAL_TRUNCATION_MESSAGE = `较早的终端输出已折叠，仅保留最近 ${MAX_TERMINAL_LINES} 行。`;
const ansiPattern =
  // eslint-disable-next-line no-control-regex
  /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1B\\))/g;
let activeTerminalLine = null;
let pendingTerminalLogs = [];
let terminalFlushTimerId = 0;
let lastTerminalFlushAt = 0;
let terminalLineRefreshId = 0;
let terminalProgressHeartbeatTimerId = 0;
let activeVideoBatchProgressContext = null;
let modelTaskPollSummaryLine = null;
let modelTaskPollCount = 0;
const modelTaskPollIds = new Set();
const completedModelDownloadTaskIds = new Set();

const sanitizeTerminalText = (message) =>
  String(message ?? "")
    .replace(ansiPattern, "")
    .split(String.fromCharCode(8))
    .join("");

const getProgressLineKey = (message = "") => {
  const text = String(message || "").trim();
  if (!text.includes("%") || !text.includes("|")) {
    return "";
  }

  const prefix = text.split("|", 1)[0].replace(/\s*\d+%\s*$/, "").trim();
  return prefix || "terminal-progress";
};

const formatBackendModelLabel = (modelId = "") => {
  const normalized = String(modelId || "").trim().toLowerCase();
  if (normalized === "batch processing") return "批量图片";
  if (normalized === "slbr" || normalized === "slbr processing") return "SLBR";
  if (normalized === "lama" || normalized === "lama processing") return "Lama";
  return normalized ? normalized.toUpperCase() : "模型";
};

const parseDurationTokenToSeconds = (value = "") => {
  const parts = String(value || "")
    .trim()
    .split(":")
    .map((part) => Number(part));
  if (parts.some((part) => !Number.isFinite(part))) {
    return null;
  }
  if (parts.length === 3) {
    return parts[0] * 3600 + parts[1] * 60 + parts[2];
  }
  if (parts.length === 2) {
    return parts[0] * 60 + parts[1];
  }
  return parts[0] ?? null;
};

const formatDurationForTerminal = (seconds = 0) => {
  const safeSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(safeSeconds / 3600);
  const minutes = Math.floor((safeSeconds % 3600) / 60);
  const restSeconds = safeSeconds % 60;
  const pad = (value) => String(value).padStart(2, "0");
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(restSeconds)}`;
  }
  return `${pad(minutes)}:${pad(restSeconds)}`;
};

const parseTqdmProgressLine = (message = "") => {
  const text = String(message || "").trim();
  const match = text.match(
    /^(?:([^:\r\n]+):\s*)?(\d+)%\|.*\|\s*(\d+)\/(\d+)\s*\[([^<,\]]+)(?:<([^,\]]+))?(?:,\s*([^\]]+))?\]/
  );
  if (!match) {
    return null;
  }

  const [, label, percent, current, total, elapsed, remaining, rate] = match;
  return {
    label: String(label || "").trim(),
    percent: Number(percent),
    current: Number(current),
    total: Number(total),
    baseElapsedSeconds: parseDurationTokenToSeconds(elapsed),
    baseRemainingSeconds: parseDurationTokenToSeconds(remaining),
    rateText: String(rate || "").trim(),
    receivedAtMs: Date.now(),
  };
};

const isCompleteProgressInfo = (progressInfo = {}) =>
  Number(progressInfo.percent) >= 100 ||
  (Number.isFinite(progressInfo.current) &&
    Number.isFinite(progressInfo.total) &&
    Number(progressInfo.total) > 0 &&
    Number(progressInfo.current) >= Number(progressInfo.total));

const buildLiveProgressMessage = (progressInfo = {}, now = Date.now()) => {
  const elapsedDeltaSeconds = Math.max(
    0,
    (Number(now || Date.now()) - Number(progressInfo.receivedAtMs || now)) / 1000
  );
  const elapsedSeconds = Number.isFinite(progressInfo.baseElapsedSeconds)
    ? progressInfo.baseElapsedSeconds + elapsedDeltaSeconds
    : null;
  const remainingSeconds = Number.isFinite(progressInfo.baseRemainingSeconds)
    ? Math.max(0, progressInfo.baseRemainingSeconds - elapsedDeltaSeconds)
    : null;
  const label = formatBackendModelLabel(progressInfo.label);
  const progressText =
    Number.isFinite(progressInfo.current) && Number.isFinite(progressInfo.total)
      ? `${progressInfo.current}/${progressInfo.total}`
      : "";
  const percentText = Number.isFinite(progressInfo.percent) ? `${progressInfo.percent}%` : "";
  const timing = [];
  if (elapsedSeconds !== null) {
    timing.push(`已用 ${formatDurationForTerminal(elapsedSeconds)}`);
  }
  if (remainingSeconds !== null) {
    timing.push(`预计剩余 ${formatDurationForTerminal(remainingSeconds)}`);
  }
  const rateText = progressInfo.rateText
    ? `，平均 ${progressInfo.rateText.replace("/it", "/项")}`
    : "";
  const progressSuffix = [progressText, percentText].filter(Boolean).join("，");

  const actionText = progressInfo.completed || isCompleteProgressInfo(progressInfo)
    ? "处理完成"
    : "正在处理";

  return `${label} ${actionText}${progressSuffix ? `：${progressSuffix}` : ""}${
    timing.length ? `，${timing.join("，")}` : ""
  }${rateText}。`;
};

const getLiveProgressElapsedSeconds = (progressInfo = {}, now = Date.now()) =>
  Number.isFinite(progressInfo.baseElapsedSeconds)
    ? progressInfo.baseElapsedSeconds +
      Math.max(0, (Number(now) - Number(progressInfo.receivedAtMs || now)) / 1000)
    : null;

const getLiveProgressRemainingSeconds = (progressInfo = {}, now = Date.now()) =>
  Number.isFinite(progressInfo.baseRemainingSeconds)
    ? Math.max(
        0,
        progressInfo.baseRemainingSeconds -
          Math.max(0, (Number(now) - Number(progressInfo.receivedAtMs || now)) / 1000)
      )
    : null;

const isSameProgressStep = (left = {}, right = {}) =>
  left &&
  right &&
  left.label === right.label &&
  left.percent === right.percent &&
  left.current === right.current &&
  left.total === right.total;

const mergeLiveProgressInfo = (currentInfo, incomingInfo, now = Date.now()) => {
  if (!currentInfo || !incomingInfo || !isSameProgressStep(currentInfo, incomingInfo)) {
    return incomingInfo;
  }

  const currentElapsed = getLiveProgressElapsedSeconds(currentInfo, now);
  const incomingElapsed = Number.isFinite(incomingInfo.baseElapsedSeconds)
    ? incomingInfo.baseElapsedSeconds
    : null;

  if (currentElapsed === null || incomingElapsed === null || currentElapsed <= incomingElapsed) {
    return incomingInfo;
  }

  const currentRemaining = getLiveProgressRemainingSeconds(currentInfo, now);
  return {
    ...incomingInfo,
    baseElapsedSeconds: currentElapsed,
    baseRemainingSeconds:
      currentRemaining === null ? incomingInfo.baseRemainingSeconds : currentRemaining,
    receivedAtMs: now,
  };
};

const stripBackendLogEnvelope = (message = "") =>
  String(message || "")
    .trim()
    .replace(/^\[\d{2}:\d{2}:\d{2}\]\s*/, "")
    .replace(
      /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(?:\.\d+)?\s+\|\s+\w+\s+\|\s+[\s\S]*?\s+-\s+/,
      ""
    );

const normalizeBackendLogPayload = (message = "") =>
  stripBackendLogEnvelope(message).replace(/\s*\r?\n\s*/g, " ").trim();

const parseModelTaskPollLog = (message = "") => {
  const payload = normalizeBackendLogPayload(message);
  const match = payload.match(
    /\bGET\s+\/api\/v1\/moonshine\/models\/tasks\/([^?\s"']+)(?:\?[^\s"']*)?\s+HTTP\/\d(?:\.\d)?["']?\s+(\d{3})\b/i
  );
  if (!match) return null;
  return {
    taskId: match[1],
    statusCode: Number(match[2]),
  };
};

const parseVideoBatchStartLog = (message = "") => {
  const match = normalizeBackendLogPayload(message).match(
    /^\[(batch_[^\]]+)\]\s+start\s+video\s+batch:\s*(\d+)\s*frame\(s\),\s*model=([^,\s]+),\s*batch=(\d+)\/(\d+)/i
  );
  if (!match) {
    return null;
  }
  return {
    kind: "video-start",
    batchId: match[1],
    totalFrames: Number(match[2]),
    modelId: String(match[3] || "").trim(),
    batchNumber: Number(match[4]),
    totalBatches: Number(match[5]),
  };
};

const parseVideoBatchFinishLog = (message = "") => {
  const match = normalizeBackendLogPayload(message).match(
    /^\[(batch_[^\]]+)\]\s+finished\s+video\s+batch:\s*model=([^,\s]+),\s*batch=(\d+)\/(\d+),\s*total_frames=(\d+),\s*success=(\d+),\s*failed=(\d+),\s*elapsed=([\d.]+)s/i
  );
  if (!match) {
    return null;
  }
  return {
    kind: "video-finish",
    batchId: match[1],
    modelId: String(match[2] || "").trim(),
    batchNumber: Number(match[3]),
    totalBatches: Number(match[4]),
    totalFrames: Number(match[5]),
    successCount: Number(match[6]),
    failedCount: Number(match[7]),
    elapsedSeconds: Number(match[8]),
  };
};

const parseImageBatchFinishLog = (message = "") => {
  const match = normalizeBackendLogPayload(message).match(
    /^Batch processing completed in\s*([\d.]+)s\s*for\s*(\d+)\s*images/i
  );
  if (!match) {
    return null;
  }
  return {
    kind: "image-finish",
    modelId: "batch processing",
    totalFrames: Number(match[2]),
    successCount: Number(match[2]),
    failedCount: 0,
    elapsedSeconds: Number(match[1]),
  };
};

const getBackendTerminalLogInfo = (message = "") =>
  parseVideoBatchStartLog(message) ||
  parseVideoBatchFinishLog(message) ||
  parseImageBatchFinishLog(message);

const normalizeBackendTerminalText = (message = "") => {
  const payload = normalizeBackendLogPayload(message);
  const progressInfo = parseTqdmProgressLine(payload);
  if (progressInfo) {
    return buildLiveProgressMessage(progressInfo);
  }

  const startLog = parseVideoBatchStartLog(message);
  if (startLog) {
    return `开始处理视频批次 ${startLog.batchNumber}/${startLog.totalBatches}：共 ${startLog.totalFrames} 帧，模型 ${formatBackendModelLabel(startLog.modelId)}。`;
  }

  const finishLog = parseVideoBatchFinishLog(message);
  if (finishLog) {
    return `视频批次 ${finishLog.batchNumber}/${finishLog.totalBatches} 处理完成：共 ${finishLog.totalFrames} 帧，成功 ${finishLog.successCount} 帧，失败 ${finishLog.failedCount} 帧，用时 ${finishLog.elapsedSeconds} 秒。`;
  }

  const imageFinishLog = parseImageBatchFinishLog(message);
  if (imageFinishLog) {
    if (imageFinishLog.totalFrames === 1) {
      return `单张图片处理完成，用时 ${imageFinishLog.elapsedSeconds} 秒。`;
    }
    return `批量图片处理完成：共 ${imageFinishLog.totalFrames} 张，用时 ${imageFinishLog.elapsedSeconds} 秒。`;
  }

  const metaMatch = payload.match(
    /^\u672c\u6b21\u89c6\u9891\u5904\u7406\u603b\u5171\s*(\d+)\s*\u6279\u6b21\uff0c?\u5f53\u524d\u7b2c\s*(\d+)\s*\u6279/u
  );
  if (metaMatch) {
    return `视频处理进度：当前第 ${metaMatch[2]}/${metaMatch[1]} 批。`;
  }

  return payload.replace(/,\s*outputs=\[[\s\S]*\]\s*$/u, "。");
};

const isProgressMetaLine = (message = "") => {
  const text = String(message || "").trim();
  return (
    /\u672c\u6b21\u89c6\u9891\u5904\u7406\u603b\u5171\s*\d+\s*\u6279\u6b21/u.test(text) &&
    /\u5f53\u524d\u7b2c\s*\d+\s*\u6279/u.test(text) &&
    /\u5f53\u524d\u6279\u6b21\u8fdb\u5ea6\u5982\u4e0b[:\uff1a]?\s*$/u.test(text)
  );
};

const isProgressLine = (message = "") =>
  Boolean(getProgressLineKey(message)) || isProgressMetaLine(message);

const createTerminalLine = (message, type = "info", options = {}) => ({
  message,
  type,
  timestamp: options.timestamp || new Date().toLocaleTimeString(),
  system: Boolean(options.system),
  progressKey: options.progressKey || "",
  progressActive: Boolean(options.progressActive),
  progressInfo: options.progressInfo || null,
  refreshId: ++terminalLineRefreshId,
});

const updateModelTaskPollSummary = ({ taskId, statusCode }) => {
  modelTaskPollCount += 1;
  if (taskId) modelTaskPollIds.add(taskId);
  const taskSummary = modelTaskPollIds.size > 1 ? `，${modelTaskPollIds.size} 个任务` : "";
  const message = `模型任务状态轮询：已合并 ${modelTaskPollCount} 次 GET 请求${taskSummary}（最近状态 ${statusCode}）。`;
  const timestamp = new Date().toLocaleTimeString();

  if (modelTaskPollSummaryLine && terminalOutput.value.includes(modelTaskPollSummaryLine)) {
    modelTaskPollSummaryLine.message = message;
    modelTaskPollSummaryLine.timestamp = timestamp;
    modelTaskPollSummaryLine.refreshId = ++terminalLineRefreshId;
    return;
  }

  modelTaskPollSummaryLine = createTerminalLine(message, "info", { timestamp });
  terminalOutput.value.push(modelTaskPollSummaryLine);
};

const getProgressLineKeyFromInfo = (progressInfo = {}) =>
  progressInfo ? `progress:${progressInfo.label || "backend"}` : "";

const findActiveProgressLine = (progressKey) => {
  if (!progressKey) {
    return null;
  }

  for (let index = terminalOutput.value.length - 1; index >= 0; index -= 1) {
    const line = terminalOutput.value[index];
    if (line?.progressKey === progressKey && line.progressActive) {
      return line;
    }
  }

  return null;
};

const trimTerminalOutput = () => {
  if (terminalOutput.value.length <= MAX_TERMINAL_LINES) {
    return;
  }

  const maxDataLines = Math.max(1, MAX_TERMINAL_LINES - 1);
  const recentLines = terminalOutput.value
    .filter((line) => !line.system)
    .slice(-maxDataLines);

  terminalOutput.value = [
    createTerminalLine(TERMINAL_TRUNCATION_MESSAGE, "warning", {
      system: true,
      timestamp: "--:--:--",
    }),
    ...recentLines,
  ];

  if (activeTerminalLine && !terminalOutput.value.includes(activeTerminalLine)) {
    activeTerminalLine = null;
  }
};

const getActiveProgressLines = () =>
  terminalOutput.value.filter((line) => line?.progressActive && line.progressInfo);

const clearTerminalProgressHeartbeat = () => {
  if (terminalProgressHeartbeatTimerId) {
    window.clearInterval(terminalProgressHeartbeatTimerId);
    terminalProgressHeartbeatTimerId = 0;
  }
};

const refreshLiveProgressLines = () => {
  const lines = getActiveProgressLines();
  if (lines.length === 0) {
    clearTerminalProgressHeartbeat();
    return;
  }

  const now = Date.now();
  const timestamp = new Date().toLocaleTimeString();
  lines.forEach((line) => {
    line.message = buildLiveProgressMessage(line.progressInfo, now);
    line.timestamp = timestamp;
    line.refreshId = ++terminalLineRefreshId;
  });
};

const ensureTerminalProgressHeartbeat = () => {
  if (terminalProgressHeartbeatTimerId || getActiveProgressLines().length === 0) {
    return;
  }
  terminalProgressHeartbeatTimerId = window.setInterval(
    refreshLiveProgressLines,
    TERMINAL_PROGRESS_HEARTBEAT_MS
  );
};

const syncTerminalProgressHeartbeat = () => {
  if (getActiveProgressLines().length > 0) {
    ensureTerminalProgressHeartbeat();
  } else {
    clearTerminalProgressHeartbeat();
  }
};

const deactivateTerminalProgressLines = () => {
  getActiveProgressLines().forEach((line) => {
    line.progressActive = false;
    line.progressInfo = null;
    line.refreshId = ++terminalLineRefreshId;
  });
};

const completeActiveProgressLine = (completionInfo = {}) => {
  const activeLines = getActiveProgressLines();
  if (activeLines.length === 0) {
    return false;
  }

  const line = activeLines[activeLines.length - 1];
  const previousInfo = line.progressInfo || {};
  const now = Date.now();
  const total = Number(completionInfo.totalFrames || previousInfo.total || 0);
  const elapsedSeconds =
    Number.isFinite(completionInfo.elapsedSeconds) && Number(completionInfo.elapsedSeconds) > 0
      ? Number(completionInfo.elapsedSeconds)
      : getLiveProgressElapsedSeconds(previousInfo, now);
  const completedInfo = {
    ...previousInfo,
    label: previousInfo.label || completionInfo.modelId || "backend",
    percent: 100,
    current: total || previousInfo.current || previousInfo.total || 0,
    total: total || previousInfo.total || previousInfo.current || 0,
    baseElapsedSeconds: Number.isFinite(elapsedSeconds) ? elapsedSeconds : previousInfo.baseElapsedSeconds,
    baseRemainingSeconds: 0,
    rateText: previousInfo.rateText || "",
    receivedAtMs: now,
    completed: true,
  };

  line.message = buildLiveProgressMessage(completedInfo, now);
  line.timestamp = new Date().toLocaleTimeString();
  line.type = "progress-complete";
  line.progressActive = false;
  line.progressInfo = null;
  line.progressKey = line.progressKey || getProgressLineKeyFromInfo(completedInfo);
  line.refreshId = ++terminalLineRefreshId;
  syncTerminalProgressHeartbeat();
  return true;
};

const scrollTerminalToBottom = () => {
  nextTick(() => {
    if (terminalRef.value) {
      terminalRef.value.scrollTop = terminalRef.value.scrollHeight;
    }
  });
};

const getTerminalLineClass = (line = {}) => {
  switch (line.type) {
    case "error":
      return "terminal-line--error";
    case "warning":
      return "terminal-line--warning";
    case "success":
      return "terminal-line--success";
    case "progress":
      return "terminal-line--progress";
    case "progress-complete":
      return "terminal-line--progress-complete";
    default:
      return "terminal-line--info";
  }
};

const clearTerminal = () => {
  terminalOutput.value = [];
  activeTerminalLine = null;
  activeVideoBatchProgressContext = null;
  modelTaskPollSummaryLine = null;
  modelTaskPollCount = 0;
  modelTaskPollIds.clear();
  pendingTerminalLogs = [];
  lastTerminalFlushAt = Date.now();
  clearTerminalProgressHeartbeat();
  if (terminalFlushTimerId) {
    window.clearTimeout(terminalFlushTimerId);
    terminalFlushTimerId = 0;
  }
  addTerminalLog("终端已清空", "info");
};

const copyStartupDiagnostic = async () => {
  if (!activeDiagnostic.value) return;
  const content = JSON.stringify(
    {
      error: backendEngineStore.error || undefined,
      recoveryHint: backendEngineStore.recoveryHint || undefined,
      diagnostic: activeDiagnostic.value,
    },
    null,
    2
  );
  try {
    await copyToClipboard(content);
    $q.notify({ type: "positive", message: "启动诊断已复制" });
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `复制启动诊断失败：${error?.message || "未知错误"}`,
    });
  }
};

const openStartupLog = async () => {
  try {
    const result = await window.electron?.ipcRenderer?.invoke?.("open-startup-log");
    if (!result?.success) {
      throw new Error(result?.error || "无法打开启动日志");
    }
  } catch (error) {
    $q.notify({
      type: "negative",
      message: `打开启动日志失败：${error?.message || "未知错误"}`,
    });
  }
};

const flushPendingTerminalLogs = () => {
  terminalFlushTimerId = 0;
  if (pendingTerminalLogs.length === 0) {
    return;
  }

  const logs = pendingTerminalLogs;
  pendingTerminalLogs = [];
  lastTerminalFlushAt = Date.now();
  logs.forEach((item) => addTerminalLog(item.message, item.type));
};

const getQueuedTerminalLogType = (item = {}) => {
  const rawText = sanitizeTerminalText(item.message);
  let progressInfo = parseTqdmProgressLine(stripBackendLogEnvelope(rawText));
  const message = normalizeBackendTerminalText(rawText);
  return progressInfo || isProgressLine(message) || item.type === "progress"
    ? "progress"
    : item.type || "info";
};

const scheduleTerminalLogFlush = () => {
  if (pendingTerminalLogs.length === 0) {
    return;
  }

  const now = Date.now();
  const hasPendingProgress = pendingTerminalLogs.some(
    (item) => getQueuedTerminalLogType(item) === "progress"
  );

  if (!hasPendingProgress) {
    flushPendingTerminalLogs();
    return;
  }

  const elapsedSinceFlush = Math.max(0, now - lastTerminalFlushAt);
  const oldestQueuedAt = pendingTerminalLogs.reduce(
    (oldest, item) => Math.min(oldest, Number(item.queuedAt || now)),
    now
  );
  const oldestAge = Math.max(0, now - oldestQueuedAt);

  const minDelay = Math.max(
    0,
    TERMINAL_PROGRESS_SYNC_MIN_MS - elapsedSinceFlush,
    TERMINAL_PROGRESS_SYNC_MIN_MS - oldestAge
  );
  const maxDelay = Math.max(0, TERMINAL_PROGRESS_SYNC_MAX_MS - oldestAge);
  const delay = Math.min(minDelay, maxDelay);

  if (delay === 0) {
    if (terminalFlushTimerId) {
      window.clearTimeout(terminalFlushTimerId);
      terminalFlushTimerId = 0;
    }
    flushPendingTerminalLogs();
    return;
  }

  if (!terminalFlushTimerId) {
    terminalFlushTimerId = window.setTimeout(flushPendingTerminalLogs, delay);
  }
};

const queueTerminalLog = (message, type = "info") => {
  pendingTerminalLogs.push({ message, type, queuedAt: Date.now() });
  scheduleTerminalLogFlush();
};

const reportCompletedModelDownload = (task = {}) => {
  const taskId = String(task.id || "").trim();
  if (!taskId || completedModelDownloadTaskIds.has(taskId)) return;
  completedModelDownloadTaskIds.add(taskId);
  const modelId = String(task.modelId || "").trim();
  const model = modelRegistryStore.models.find((item) => item.id === modelId);
  const displayName = String(model?.label || modelId || "模型").trim() || "模型";
  addTerminalLog(`模型${displayName}下载成功。`, "success");
};

// IPC 监听器处理后端输出
const handleBackendOutput = (event, data) => {
  if (typeof data === "string") {
    queueTerminalLog(data, "info");
    return;
  }
  queueTerminalLog(data?.message, data?.type);
};

const handlePythonInstallPath = (event, path) => {
  addTerminalLog(`Python 安装包下载完成，正在安装（临时文件：${path}）。`, "info");
};

const markEnvironmentReadyForRunningProcess = () => {
  environmentStatus.python = true;
  environmentStatus.project = true;
  environmentStatus.venv = true;
  environmentStatus.dependencies = true;
  environmentStatus.configured = true;
  setAllEnvironmentItemStates("success");
  pythonVersion.value =
    pythonVersion.value ||
    (isBundledBackendMode.value ? "本地运行环境已就绪" : "Python detected");
  venvStatus.value = isBundledBackendMode.value ? "运行环境已就绪" : "Ready";
  dependenciesStatus.value = isBundledBackendMode.value
    ? "内置依赖已就绪"
    : "Installed";
  environmentStatus.error = false;
  environmentCheckCompleted.value = true;
};

const completeEnvironmentCheckForRunningService = () => {
  const runningConfirmed = observedBackendRunning.value;
  const startingProcessConfirmed =
    serviceStatus.value === "starting" && backendEngineStore.processRunning === true;
  if (!runningConfirmed && !startingProcessConfirmed) {
    return false;
  }
  markEnvironmentReadyForRunningProcess();
  currentStep.value = 3;
  addTerminalLog("检测到服务正在运行，跳过其余运行环境检测", "info");
  return true;
};

const setServiceStartingFromProcess = () => {
  markEnvironmentReadyForRunningProcess();
  currentStep.value = 3;
  backendEngineStore.setPreparing("verifying", {
    processRunning: true,
    ready: false,
  });
};

// 检查服务状态的函数
const checkServiceStatus = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke("check-backend-status");
    if (result?.success) {
      backendEngineStore.applyServiceEvent(result);
      if (result.state === "failed" || result.state === "stopping") {
        return;
      } else if (result.running || result.ready) {
        markEnvironmentReadyForRunningProcess();
      } else if (result.processRunning && (!result.state || result.state === "starting")) {
        setServiceStartingFromProcess();
      }
    }
  } catch (error) {
    console.error("检查服务状态失败:", error);
    if (!backendEngineStore.processRunning) {
      backendEngineStore.setStopped();
    }
  }
};

watch(
  () => props.modelValue && observedBackendRunning.value,
  async (running) => {
    if (!running || serviceStatus.value === "running") {
      return;
    }
    stopServiceProcessPolling();
    await checkServiceStatus();
  },
  { flush: "post" }
);

watch(
  () => props.modelValue && isBackendPreparing.value && !observedBackendRunning.value,
  (shouldPoll) => {
    if (shouldPoll) {
      startServiceProcessPolling();
      return;
    }
    stopServiceProcessPolling();
  },
  { flush: "post" }
);

// 监听对话框显示状态
watch(
  () => props.modelValue,
  async (newVal) => {
    showDialog.value = newVal;
    if (!newVal) {
      stopServiceProcessPolling();
      return;
    }

    try {
      await checkEnvironment({ syncServiceStatus: true });
    } catch (error) {
      environmentStatus.error = true;
      environmentCheckCompleted.value = true;
      checking.value = false;
      finishUncheckedEnvironmentItems();
      addTerminalLog(`环境检测初始化失败：${error?.message || "未知错误"}`, "error");
    }

    if (isBackendPreparing.value && !observedBackendRunning.value) {
      startServiceProcessPolling();
    }
  }
);

// 监听配置变化
watch(
  () => configStore.config,
  (newConfig) => {
    backendConfig.port = newConfig.general.backendPort || 8080;
    backendConfig.device = newConfig.general.launchMode || "cuda";
    backendConfig.model = newConfig.general.defaultModel || "lama";
    backendConfig.projectPath = newConfig.general.backendProjectPath || "";
    backendConfig.modelDir = newConfig.general.modelDir || "";
    backendConfig.samReleaseBeforeProcessing =
      newConfig.masking?.samReleaseBeforeProcessing !== false;
    fallbackMatDefaultModelIfNeeded();
  },
  { deep: true }
);

watch(showDialog, (newVal) => {
  emit("update:modelValue", newVal);
});

watch(
  () => [backendConfig.device, backendConfig.model],
  () => {
    fallbackMatDefaultModelIfNeeded({ notify: true, log: true });
  }
);

watch(
  () => Object.values(modelRegistryStore.tasks || {}).map((task) => ({
    id: task?.id,
    modelId: task?.modelId,
    status: task?.status,
    done: task?.done,
  })),
  (tasks) => {
    tasks.forEach((task) => {
      if (task?.status === "completed" && task.done) {
        reportCompletedModelDownload(task);
      }
    });
  },
  { deep: true }
);

// 添加终端日志
const addTerminalLog = (message, type = "info") => {
  const rawText = sanitizeTerminalText(message);
  const cleanText = normalizeBackendTerminalText(rawText);
  if (!cleanText) {
    return;
  }

  const modelTaskPoll = parseModelTaskPollLog(rawText);
  if (modelTaskPoll && modelTaskPoll.statusCode >= 200 && modelTaskPoll.statusCode < 400) {
    updateModelTaskPollSummary(modelTaskPoll);
    trimTerminalOutput();
    scrollTerminalToBottom();
    return;
  }

  const logInfo = getBackendTerminalLogInfo(rawText);
  const isCompletionLog = logInfo?.kind === "video-finish" || logInfo?.kind === "image-finish";
  if (logInfo?.kind === "video-start") {
    activeVideoBatchProgressContext = logInfo;
  }

  let progressInfo = parseTqdmProgressLine(stripBackendLogEnvelope(rawText));
  if (progressInfo && !progressInfo.label && activeVideoBatchProgressContext?.modelId) {
    progressInfo = {
      ...progressInfo,
      label: activeVideoBatchProgressContext.modelId,
    };
  }
  const isParsedProgressComplete =
    Boolean(progressInfo) && isCompleteProgressInfo(progressInfo);
  const lineType =
    isCompletionLog || isParsedProgressComplete
      ? "progress-complete"
      : progressInfo || isProgressLine(cleanText) || type === "progress"
        ? "progress"
        : type;
  const timestamp = new Date().toLocaleTimeString();
  const hasCursorControl = cleanText.includes("\r") || cleanText.includes("\n");
  const getTerminalProgressKey = (text) =>
    getProgressLineKey(text) ||
    getProgressLineKeyFromInfo(progressInfo);

  let buffer = "";
  let shouldOverwriteCurrentLine = false;
  const assignLinePayload = (line, text, progressKey) => {
    const isSameProgressRefresh =
      line.message === text &&
      line.type === lineType &&
      line.progressKey === progressKey &&
      line.progressActive === (lineType === "progress" && Boolean(progressKey)) &&
      lineType === "progress";
    if (isSameProgressRefresh) {
      line.timestamp = timestamp;
      line.progressInfo = progressInfo;
      line.refreshId = ++terminalLineRefreshId;
      syncTerminalProgressHeartbeat();
      return true;
    }

    if (
      line.message === text &&
      line.type === lineType &&
      line.progressKey === progressKey &&
      line.progressActive === (lineType === "progress" && Boolean(progressKey))
    ) {
      return false;
    }

    line.message = text;
    line.type = lineType;
    line.timestamp = timestamp;
    line.progressKey = progressKey;
    line.progressActive = lineType === "progress" && Boolean(progressKey);
    line.progressInfo = line.progressActive ? progressInfo : null;
    line.refreshId = ++terminalLineRefreshId;
    syncTerminalProgressHeartbeat();
    return true;
  };

  const writeActiveLine = (text) => {
    const progressKey = getTerminalProgressKey(text);
    const existingProgressLine = findActiveProgressLine(progressKey);
    if (existingProgressLine) {
      progressInfo = mergeLiveProgressInfo(existingProgressLine.progressInfo, progressInfo);
      assignLinePayload(
        existingProgressLine,
        progressInfo ? buildLiveProgressMessage(progressInfo) : text,
        progressKey
      );
      activeTerminalLine = existingProgressLine;
      return;
    }

    if (
      activeTerminalLine &&
      terminalOutput.value.includes(activeTerminalLine) &&
      !activeTerminalLine.system
    ) {
      progressInfo = mergeLiveProgressInfo(activeTerminalLine.progressInfo, progressInfo);
      assignLinePayload(
        activeTerminalLine,
        progressInfo ? buildLiveProgressMessage(progressInfo) : text,
        progressKey
      );
      return;
    }

    activeTerminalLine = createTerminalLine(text, lineType, {
      timestamp,
      progressKey,
      progressActive: lineType === "progress" && Boolean(progressKey),
      progressInfo: lineType === "progress" ? progressInfo : null,
    });
    terminalOutput.value.push(activeTerminalLine);
    syncTerminalProgressHeartbeat();
  };

  const writeFinalLine = (text) => {
    if (isCompletionLog) {
      completeActiveProgressLine(logInfo);
      activeVideoBatchProgressContext =
        logInfo.kind === "video-finish" ? null : activeVideoBatchProgressContext;
    } else if (isParsedProgressComplete) {
      const completedExistingLine = completeActiveProgressLine({
        modelId: progressInfo?.label || "backend",
        totalFrames: progressInfo?.total,
        elapsedSeconds: progressInfo?.baseElapsedSeconds,
      });
      if (completedExistingLine) {
        activeTerminalLine = null;
        syncTerminalProgressHeartbeat();
        return;
      }
    } else if (lineType === "error" || lineType === "warning") {
      deactivateTerminalProgressLines();
    }
    terminalOutput.value.push(
      createTerminalLine(text, lineType, {
        timestamp,
        progressKey: isParsedProgressComplete ? getTerminalProgressKey(text) : "",
        progressActive: false,
        progressInfo: null,
      })
    );
    activeTerminalLine = null;
    syncTerminalProgressHeartbeat();
  };

  const flushBuffer = ({ active = false, finalize = false } = {}) => {
    if (!buffer) {
      if (finalize) {
        if (activeTerminalLine) {
          activeTerminalLine.progressActive = false;
          activeTerminalLine.progressInfo = null;
        }
        activeTerminalLine = null;
        syncTerminalProgressHeartbeat();
      }
      return;
    }

    if (active || shouldOverwriteCurrentLine) {
      writeActiveLine(buffer);
    } else {
      writeFinalLine(buffer);
    }

    buffer = "";
    shouldOverwriteCurrentLine = false;
    if (finalize) {
      if (activeTerminalLine) {
        activeTerminalLine.progressActive = false;
        activeTerminalLine.progressInfo = null;
      }
      activeTerminalLine = null;
      syncTerminalProgressHeartbeat();
    }
    trimTerminalOutput();
  };

  if (!hasCursorControl) {
    if (lineType === "progress") {
      writeActiveLine(cleanText);
    } else {
      writeFinalLine(cleanText);
    }
    trimTerminalOutput();
    scrollTerminalToBottom();
    return;
  }

  for (const char of cleanText.split("\r\n").join("\n")) {
    if (char === "\r") {
      flushBuffer({ active: true });
      shouldOverwriteCurrentLine = true;
      continue;
    }

    if (char === "\n") {
      flushBuffer({ finalize: true });
      continue;
    }

    buffer += char;
  }

  flushBuffer();
  scrollTerminalToBottom();
};

const fallbackMatDefaultModelIfNeeded = ({ notify = false, log = false } = {}) => {
  if (backendConfig.model !== "mat" || backendConfig.device === "cuda") {
    return false;
  }

  backendConfig.model = "lama";
  if (notify) {
    $q.notify({ type: "warning", message: MAT_CUDA_FALLBACK_MESSAGE, position: "top" });
  }
  if (log) {
    addTerminalLog(MAT_CUDA_FALLBACK_MESSAGE, "warning");
  }
  return true;
};

const persistConfig = async (nextConfig) => {
  const serializableConfig = JSON.parse(JSON.stringify(nextConfig));
  const electronResult = await window.electron.ipcRenderer.invoke(
    "save-app-config",
    serializableConfig
  );
  if (!electronResult?.success) {
    throw new Error(electronResult?.error || "配置持久化失败");
  }

  // The main process owns the current MCP policy. Use its returned complete
  // config so this legacy direct-save path cannot reintroduce a stale renderer
  // MCP snapshot into Pinia memory after the disk write succeeds.
  const effectiveConfig = electronResult?.config || nextConfig;
  const storeResult = await configStore.saveConfig(effectiveConfig);
  if (!storeResult?.success) {
    if (Array.isArray(storeResult?.errors) && storeResult.errors.length > 0) {
      throw new Error(storeResult.errors.join("; "));
    }
    throw new Error(storeResult?.error || "配置更新失败");
  }
};

const syncEnvironmentLaunchDevice = async (accelerator, { log = false } = {}) => {
  if (!["cpu", "cu130"].includes(accelerator)) return false;
  const effectiveDevice = accelerator === "cu130" ? "cuda" : "cpu";
  const changed = backendConfig.device !== effectiveDevice ||
    configStore.config.general?.launchMode !== effectiveDevice;
  backendConfig.device = effectiveDevice;
  api.updateConfig({ general: { launchMode: effectiveDevice } });
  if (!changed) return true;
  try {
    await persistConfig({
      ...configStore.config,
      general: {
        ...(configStore.config.general || {}),
        launchMode: effectiveDevice,
      },
    });
    if (log) {
      addTerminalLog(
        `服务启动方式已同步为${effectiveDevice === "cuda" ? " CUDA" : " CPU"}。`,
        "info"
      );
    }
    return true;
  } catch (error) {
    addTerminalLog(
      `当前运行环境可用，但服务启动方式配置同步失败：${error?.message || "未知错误"}`,
      "warning"
    );
    return false;
  }
};

const syncRuntimeBackendPort = async (port) => {
  const normalizedPort = Number(port);
  if (
    !Number.isInteger(normalizedPort) ||
    normalizedPort < 1024 ||
    normalizedPort > 65535
  ) {
    return false;
  }

  backendConfig.port = normalizedPort;
  api.updateConfig({
    general: {
      backendPort: normalizedPort
    }
  });

  if (configStore.config.general?.backendPort === normalizedPort) {
    return true;
  }

  try {
    await persistConfig({
      ...configStore.config,
      general: {
        ...(configStore.config.general || {}),
        backendPort: normalizedPort,
      },
    });
  } catch (error) {
    addTerminalLog(
      `服务端口已切换到 ${normalizedPort}，但配置持久化失败：${error?.message || "未知错误"}。`,
      "warning"
    );
    return false;
  }

  return true;
};

const syncBackendMode = (mode = "external") => {
  backendMode.value = mode === "bundled" ? "bundled" : "external";
};

const resolveCheckedProjectPath = (projectResult = {}) =>
  [
    projectResult.path,
    backendConfig.projectPath,
    projectPath.value,
    configStore.config.general?.backendProjectPath,
  ]
    .map((value) => (typeof value === "string" ? value.trim() : ""))
    .find(Boolean) || "";

const syncCurrentBackendMode = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke(
      "check-project",
      backendConfig.projectPath
    );
    if (!result?.success) {
      return;
    }

    syncBackendMode(result.backendMode);
    if (result.path) {
      projectPath.value = result.path;
      backendConfig.projectPath = result.path;
    }
  } catch (error) {
    console.warn("Failed to sync backend mode:", error);
  }
};

const syncServiceProcessStatus = async () => {
  if (!props.modelValue || observedBackendRunning.value || serviceStatus.value === "running") {
    return;
  }

  try {
    const result = await window.electron.ipcRenderer.invoke("check-backend-status");
    if (result?.success) {
      backendEngineStore.applyServiceEvent(result);
    }
    if (result?.success && (result.state === "failed" || result.state === "stopping")) {
      return;
    }
    if (result?.success && (result.running || result.ready)) {
      markEnvironmentReadyForRunningProcess();
      return;
    }
    if (result?.success && result.processRunning) {
      setServiceStartingFromProcess();
      return;
    }

    if (!isBackendPreparing.value && serviceStatus.value === "starting") {
      backendEngineStore.setStopped(result || {});
    }
  } catch (error) {
    console.error("同步服务进程状态失败:", error);
    if (!isBackendPreparing.value && serviceStatus.value === "starting") {
      backendEngineStore.setFailed(error?.message || "同步服务进程状态失败");
    }
  }
};

const stopServiceProcessPolling = () => {
  if (!serviceProcessPollTimerId) {
    return;
  }
  window.clearInterval(serviceProcessPollTimerId);
  serviceProcessPollTimerId = 0;
};

const startServiceProcessPolling = () => {
  if (serviceProcessPollTimerId || !props.modelValue || observedBackendRunning.value) {
    return;
  }
  void syncServiceProcessStatus();
  serviceProcessPollTimerId = window.setInterval(() => {
    void syncServiceProcessStatus();
  }, 800);
};

const ensureBackendPathsValid = async ({
  backendProjectPath = backendConfig.projectPath || projectPath.value || "",
  modelDir = backendConfig.modelDir || "",
  notify = true,
  log = true,
  blockedMessageBuilder = null,
} = {}) => {
  const validation = await validateBackendPaths({
    backendProjectPath,
    modelDir,
  });
  if (!validation.valid) {
    const blockedMessage =
      (typeof blockedMessageBuilder === "function" && blockedMessageBuilder(validation)) ||
      buildBackendPathBlockedMessage(validation);
    if (log) {
      addTerminalLog(blockedMessage, "warning");
    }
    if (notify) {
      $q.notify({
        type: "negative",
        message: blockedMessage,
        position: "top",
        timeout: 6500,
      });
    }
    return false;
  }

  if (validation.warning) {
    const warningMessage = buildBackendPathWarningMessage(validation);
    if (log) {
      addTerminalLog(warningMessage, "warning");
    }
    if (notify) {
      $q.notify({
        type: "warning",
        message: warningMessage,
        position: "top",
        timeout: 8000,
      });
    }
  }
  return true;
};

const applyPreparedEnvironment = (prepareResult = {}) => {
  syncBackendMode(prepareResult.backendMode || backendMode.value);
  environmentStatus.project = true;
  environmentStatus.python = true;
  environmentStatus.venv = true;
  setEnvironmentItemState(["project", "python", "venv"], "success");

  if (prepareResult.path) {
    projectPath.value = prepareResult.path;
    backendConfig.projectPath = prepareResult.path;
  }

  if (prepareResult.modelDir !== undefined) {
    backendConfig.modelDir = prepareResult.modelDir || backendConfig.modelDir;
  }

  pythonVersion.value = prepareResult.pythonVersion
    ? `Python ${prepareResult.pythonVersion}`
    : isBundledBackendMode.value
      ? "本地运行环境已就绪"
      : "Python detected";

  const runtimeName =
    prepareResult.venvName || (isBundledBackendMode.value ? "managed-runtime" : ".venv");
  venvStatus.value = isBundledBackendMode.value
    ? `Ready (${runtimeName})`
    : `Created (${runtimeName})`;
};

const applyDependenciesStatus = (ready) => {
  environmentStatus.dependencies = !!ready;
  environmentStatus.configured = !!ready;
  setEnvironmentItemState("dependencies", ready ? "success" : "failure");
  dependenciesStatus.value = ready
    ? isBundledBackendMode.value
      ? "内置依赖已就绪"
      : "Installed"
    : isBundledBackendMode.value
      ? "内置依赖未就绪"
      : "Not installed";
};

const appendProjectPathGuidance = (result) => {
  if (!result) {
    return;
  }

  if (result.code === "PROJECT_STRUCTURE_INVALID" && result.recoveryHint) {
    addTerminalLog(result.recoveryHint, "warning");
    return;
  }

  if (!["PROJECT_NOT_SELECTED", "PROJECT_PATH_NOT_FOUND"].includes(result.code)) {
    return;
  }

  if (result.defaultProjectParentPath) {
    addTerminalLog(
      `请将 Moonshine 服务项目移动到 ${result.defaultProjectParentPath} 路径下。`,
      "warning"
    );
  } else {
    addTerminalLog("请将 Moonshine 服务项目移动到默认服务路径下。", "warning");
  }

  addTerminalLog(
    "或退出服务管理页面 → 打开全局设置 → 服务配置 → 服务项目路径 → 点击图标选择路径",
    "warning"
  );
};

const applyManagedEnvironmentState = (result = {}) => {
  const state = result.state || updateManager.runtimeState;
  const ready = ["ready", "degraded"].includes(state.status);
  const failed = ["failed", "needs-repair"].includes(state.status);
  environmentStatus.project = true;
  environmentStatus.python = ready;
  environmentStatus.venv = ready;
  environmentStatus.dependencies = ready;
  environmentStatus.configured = ready;
  environmentStatus.error = failed;
  setEnvironmentItemState("project", "success");
  setEnvironmentItemState(["python", "venv", "dependencies"], ready ? "success" : "failure");

  pythonVersion.value = state.pythonVersion
    ? `Python ${state.pythonVersion}`
    : ready
      ? "Python 环境已就绪"
      : "";
  venvStatus.value = ready
    ? state.activePath || "运行环境已就绪"
    : managedEnvironmentStatusMeta.value.label;
  dependenciesStatus.value = ready
    ? state.status === "degraded"
      ? "核心依赖已就绪，视频能力受限"
      : "依赖已就绪"
    : failed
      ? managedEnvironmentStatusMeta.value.label
      : "未就绪";
  environmentCheckCompleted.value = true;
  currentStep.value = ready ? 3 : 1;
  return ready;
};

const applyExternalEnvironmentState = (result = {}) => {
  const state = result.state || updateManager.runtimeState;
  const external = result.external || updateManager.runtimeState.external || {};
  const diagnostics = external.diagnostics || result.diagnostics || {};
  const status = externalEnvironmentStatus.value;
  const ready =
    result.success !== false &&
    result.valid !== false &&
    ["valid", "active"].includes(status);
  const degraded = diagnostics.degraded === true || state.status === "degraded";
  const resolvedPythonVersion = diagnostics.python?.version || state.pythonVersion || "";

  environmentStatus.project = true;
  environmentStatus.python = ready;
  environmentStatus.venv = ready;
  environmentStatus.dependencies = ready;
  environmentStatus.configured = ready;
  environmentStatus.error = !ready;
  setEnvironmentItemState("project", "success");
  setEnvironmentItemState(["python", "venv", "dependencies"], ready ? "success" : "failure");

  pythonVersion.value = resolvedPythonVersion
    ? `Python ${resolvedPythonVersion}`
    : ready
      ? "Python 环境已就绪"
      : "";
  venvStatus.value = ready
    ? external.selectedPath || external.normalizedPath || state.activePath || "已有运行环境已就绪"
    : externalEnvironmentStatusMeta.value.label;
  dependenciesStatus.value = ready
    ? degraded
      ? "核心依赖已就绪，视频能力受限"
      : "依赖已就绪"
    : "未就绪";
  environmentCheckCompleted.value = true;
  currentStep.value = ready ? 3 : 1;
  return ready;
};

const checkSelectedExternalEnvironment = async () => {
  const candidateId = externalEnvironment.value.candidateId;
  if (candidateId) {
    return updateManager.probeExternalEnvironment({ candidateId });
  }
  if (updateManager.runtimeState.source === "external") {
    return updateManager.checkRuntime({ accelerator: managedAccelerator.value });
  }
  return {
    success: false,
    valid: false,
    code: "EXTERNAL_ENV_SELECTION_INVALID",
    error: {
      code: "EXTERNAL_ENV_SELECTION_INVALID",
      message: "请先选择并校验已有 Python 环境。",
    },
    state: updateManager.runtimeState,
  };
};

const appendEnvironmentRecoveryGuidance = (result) => {
  const health =
    result?.health ||
    result?.details?.health ||
    result?.diagnostic?.health ||
    result?.details?.diagnostic?.health ||
    null;
  if (health && typeof health === "object") {
    [
      ["python", "Python"],
      ["torch", "PyTorch"],
      ["cuda", "CUDA"],
      ["backend", "后端模块"],
      ["ffmpeg", "FFmpeg"],
    ].forEach(([key, label]) => {
      const value = health[key];
      if (!value || (value.success !== false && value.ok !== false)) return;
      const detail = value.message || value.error || value.reason || value.stderr || "未通过";
      addTerminalLog(`健康探针失败：${label}（${detail}）`, "error");
    });
    if (Array.isArray(health.errors)) {
      health.errors.forEach((error) => {
        if (!error) return;
        const detail = typeof error === "string" ? error : error.message || JSON.stringify(error);
        addTerminalLog(`健康探针详情：${detail}`, "error");
      });
    }
  }
  addTerminalLog(
    '请重试，或手动创建可用运行环境，也可以从夸克网盘下载可用运行环境并在"已有环境"中选择。',
    "warning"
  );
};

// 检查环境
const runEnvironmentCheck = async ({ syncServiceStatus = false } = {}) => {
  checking.value = true;
  environmentCheckCompleted.value = false;
  currentStep.value = 1;
  environmentStatus.error = false;
  resetEnvironmentStatusForCheck();
  setAllEnvironmentItemStates("checking");
  addTerminalLog("开始检测服务环境...", "info");
  let currentEnvironmentStage = "initialization";

  try {
    if (syncServiceStatus) {
      currentEnvironmentStage = "sync-backend-mode";
      await syncCurrentBackendMode();
      currentEnvironmentStage = "check-service-status";
      await checkServiceStatus();
      if (completeEnvironmentCheckForRunningService()) {
        return;
      }
    }

    currentEnvironmentStage = "path-validation";
    const pathsValid = await ensureBackendPathsValid({});
    if (completeEnvironmentCheckForRunningService()) {
      return;
    }
    if (!pathsValid) {
      applyEnvironmentFailureState(
        { code: "BACKEND_PATH_VALIDATION_FAILED" },
        currentEnvironmentStage
      );
      pythonVersion.value = "";
      venvStatus.value = "未创建";
      dependenciesStatus.value = "未安装";
      environmentStatus.error = true;
      currentStep.value = 1;
      return;
    }

    currentEnvironmentStage = "check-project";
    const projectResult = await window.electron.ipcRenderer.invoke(
      "check-project",
      backendConfig.projectPath
    );
    if (completeEnvironmentCheckForRunningService()) {
      return;
    }

    if (!projectResult.success) {
      applyEnvironmentFailureState(projectResult, currentEnvironmentStage);
      environmentStatus.error = true;
      pythonVersion.value = "";
      venvStatus.value = "未创建";
      dependenciesStatus.value = "未安装";
      currentStep.value = 1;
      addTerminalLog(`服务项目检测失败：${projectResult.error}`, "error");
      appendProjectPathGuidance(projectResult);
      return;
    }

    const checkedProjectPath = resolveCheckedProjectPath(projectResult);
    if (!checkedProjectPath) {
      const pathError = {
        code: "PROJECT_PATH_MISSING",
        error: "服务项目检测未返回有效路径。",
      };
      applyEnvironmentFailureState(pathError, currentEnvironmentStage);
      environmentStatus.error = true;
      currentStep.value = 1;
      addTerminalLog(`服务项目检测失败：${pathError.error}`, "error");
      return;
    }

    syncBackendMode(projectResult.backendMode);
    environmentStatus.project = true;
    setEnvironmentItemState("project", "success");
    projectPath.value = checkedProjectPath;
    backendConfig.projectPath = checkedProjectPath;
    if (configStore.config.general.backendProjectPath !== checkedProjectPath) {
      const newConfig = { ...configStore.config };
      newConfig.general.backendProjectPath = checkedProjectPath;
      await persistConfig(newConfig);
      if (completeEnvironmentCheckForRunningService()) {
        return;
      }
    }
    addTerminalLog(`服务项目检测成功：${checkedProjectPath || "路径已确认"}`, "success");

    addTerminalLog(
      projectResult.backendMode === "bundled"
        ? "已检测到应用内置服务模式。"
        : "Detected external backend mode.",
      "info"
    );

    if (isBundledBackendMode.value && pythonEnvironmentSource.value === "managed") {
      currentEnvironmentStage = "check-managed-environment";
      const managedResult = await updateManager.checkRuntime({
        accelerator: managedAccelerator.value,
      });
      const ready = applyManagedEnvironmentState(managedResult);
      if (ready) {
        await syncEnvironmentLaunchDevice(
          managedResult?.state?.selectedAccelerator || updateManager.runtimeState.selectedAccelerator
        );
        addTerminalLog(
          updateManager.runtimeState.status === "degraded"
            ? "运行环境核心能力可用，但应用内置 FFmpeg 未通过校验，视频能力暂不可用。"
            : `运行环境检测成功：${updateManager.runtimeState.activePath || "路径已确认"}`,
          updateManager.runtimeState.status === "degraded" ? "warning" : "success"
        );
      } else {
        addTerminalLog(
          managedEnvironmentStatusMeta.value.label === "未检测到运行环境"
            ? '未检测到运行环境，可点击"创建或修复环境"开始准备。'
            : `运行环境需要处理：${managedEnvironmentStatusMeta.value.label}`,
          updateManager.runtimeState.status === "failed" ? "error" : "warning"
        );
      }
      return;
    }

    if (pythonEnvironmentSource.value === "external") {
      currentEnvironmentStage = "check-external-environment";
      const externalResult = await checkSelectedExternalEnvironment();
      const ready = applyExternalEnvironmentState(externalResult);
      if (ready) {
        await syncEnvironmentLaunchDevice(
          externalResult?.state?.selectedAccelerator || updateManager.runtimeState.selectedAccelerator
        );
        addTerminalLog(
          updateManager.runtimeState.status === "degraded"
            ? "已有环境核心能力可用，但 FFmpeg 未通过校验，视频能力暂不可用。"
            : `已有环境检测成功：${updateManager.runtimeState.activePath || externalEnvironmentPath.value}`,
          updateManager.runtimeState.status === "degraded" ? "warning" : "success"
        );
      } else {
        addTerminalLog(
          `已有环境需要处理：${externalEnvironmentStatusMeta.value.label}`,
          externalResult?.success === false ? "error" : "warning"
        );
      }
      return;
    }

    currentEnvironmentStage = "prepare-project-python";
    const prepareResult = await window.electron.ipcRenderer.invoke(
      "prepare-project-python",
      checkedProjectPath
    );
    if (completeEnvironmentCheckForRunningService()) {
      return;
    }

    if (!prepareResult.success) {
      applyEnvironmentFailureState(prepareResult, currentEnvironmentStage);
      environmentStatus.error = true;
      pythonVersion.value = "";
      venvStatus.value = "未创建";
      dependenciesStatus.value = "未安装";
      currentStep.value = 1;
      addTerminalLog(
        `Python 环境准备失败：${prepareResult.error || "未知错误"}`,
        "error"
      );
      appendProjectPathGuidance(prepareResult);
      appendEnvironmentRecoveryGuidance(prepareResult);

      if (prepareResult.manualGuide?.downloadUrl) {
        addTerminalLog(
          `手动下载链接：${prepareResult.manualGuide.downloadUrl}`,
          "warning"
        );
      }
      if (Array.isArray(prepareResult.manualGuide?.commands)) {
        addTerminalLog("手动执行命令：", "info");
        prepareResult.manualGuide.commands.forEach((command) => {
          addTerminalLog(command, "info");
        });
      }
      return;
    }

    environmentStatus.python = true;
    environmentStatus.venv = true;
    setEnvironmentItemState(["python", "venv"], "success");
    pythonVersion.value = prepareResult.pythonVersion
      ? `Python ${prepareResult.pythonVersion}`
      : "已检测到 Python";
    venvStatus.value = `已就绪（${prepareResult.venvName || ".venv"}）`;
    addTerminalLog(
      `Python 环境已就绪（来源：${prepareResult.pythonSource || "项目虚拟环境"}）`,
      "success"
    );

    applyPreparedEnvironment(prepareResult);
    addTerminalLog(
      isBundledBackendMode.value
        ? "本地运行环境已就绪。"
        : `Python environment is ready (${prepareResult.pythonSource || "project virtual environment"}).`,
      "success"
    );

    if (prepareResult.dependenciesVerified === true) {
      applyDependenciesStatus(true);
      addTerminalLog("内置服务依赖已就绪。", "success");
      currentStep.value = 3;
      return;
    }

    currentEnvironmentStage = "check-dependencies";
    const depsResult = await window.electron.ipcRenderer.invoke("check-dependencies");
    if (completeEnvironmentCheckForRunningService()) {
      return;
    }
    if (depsResult.success) {
      applyDependenciesStatus(true);
      addTerminalLog(
        isBundledBackendMode.value
          ? "内置服务依赖已就绪。"
          : "依赖已安装。",
        "success"
      );
      currentStep.value = 3;
    } else {
      applyDependenciesStatus(false);
      if (depsResult.error) {
        addTerminalLog(
          isBundledBackendMode.value
            ? `内置服务依赖检测失败：${depsResult.error}`
            : `依赖检测失败：${depsResult.error}`,
          "warning"
        );
      }
      currentStep.value = 2;
    }
  } catch (error) {
    if (completeEnvironmentCheckForRunningService()) {
      return;
    }
    environmentStatus.error = true;
    environmentStatus.configured = false;
    applyEnvironmentFailureState(error, currentEnvironmentStage);
    addTerminalLog(`环境检测失败：${error.message}`, "error");
  } finally {
    finishUncheckedEnvironmentItems();
    checking.value = false;
    environmentCheckCompleted.value = true;
  }
};

const checkEnvironment = (options = {}) => {
  if (environmentCheckPromise) {
    return environmentCheckPromise;
  }

  const activePromise = runEnvironmentCheck({
    syncServiceStatus: options?.syncServiceStatus === true,
  });
  environmentCheckPromise = activePromise.finally(() => {
    environmentCheckPromise = null;
  });
  return environmentCheckPromise;
};

// 安装 Python
const installPython = async () => {
  installing.python = true;
  addTerminalLog("开始安装 Python...", "info");

  try {
    const result = await window.electron.ipcRenderer.invoke("install-python");
    if (result.success) {
      addTerminalLog("Python 安装完成。", "success");
      await checkEnvironment();
    } else {
      addTerminalLog(`Python 安装失败：${result.error}`, "error");
    }
  } catch (error) {
    addTerminalLog(`Python 安装失败：${error.message}`, "error");
  } finally {
    installing.python = false;
  }
};

// 选择项目路径
const selectProjectPath = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke("select-folder", {
      title: "选择 Python 服务项目路径",
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];
      const pathsValid = await ensureBackendPathsValid({
        backendProjectPath: selectedPath,
        modelDir: backendConfig.modelDir || "",
        blockedMessageBuilder: (validation) =>
          buildBackendPathSelectionBlockedMessage(validation, {
            currentBackendProjectPath:
              backendConfig.projectPath || projectPath.value || configStore.config.general?.backendProjectPath || "",
            currentModelDir: backendConfig.modelDir || configStore.config.general?.modelDir || "",
            selectedBackendProjectPath: selectedPath,
          }),
      });
      if (!pathsValid) {
        return;
      }

      // 先检查选择的路径是否有效
      const checkResult = await window.electron.ipcRenderer.invoke(
        "check-project",
        selectedPath
      );

      if (checkResult.success) {
        const setResult = await window.electron.ipcRenderer.invoke(
          "set-project-path",
          selectedPath
        );

        if (setResult.success) {
          const effectiveProjectPath = setResult.path || checkResult.path || selectedPath;
          projectPath.value = effectiveProjectPath;
          backendConfig.projectPath = effectiveProjectPath;
          syncBackendMode(setResult.backendMode || checkResult.backendMode);
          environmentStatus.project = true;

          // 保存到配置文件
          const newConfig = { ...configStore.config };
          newConfig.general.backendProjectPath = effectiveProjectPath;
          await persistConfig(newConfig);

          addTerminalLog(`项目路径设置成功: ${effectiveProjectPath}`, "success");
          await checkEnvironment();
        } else {
          addTerminalLog(`项目路径设置失败: ${setResult.error}`, "error");
        }
      } else {
        addTerminalLog(`项目路径无效: ${checkResult.error}`, "error");
      }
    }
  } catch (error) {
    addTerminalLog(`选择项目路径失败: ${error.message}`, "error");
  }
};
// 选择模型目录
const selectModelDir = async () => {
  try {
    const result = await window.electron.ipcRenderer.invoke("select-folder", {
      title: "选择模型路径",
    });

    if (!result.canceled && result.filePaths.length > 0) {
      const selectedPath = result.filePaths[0];
      const pathsValid = await ensureBackendPathsValid({
        backendProjectPath: backendConfig.projectPath || projectPath.value || "",
        modelDir: selectedPath,
        blockedMessageBuilder: (validation) =>
          buildBackendPathSelectionBlockedMessage(validation, {
            currentBackendProjectPath:
              backendConfig.projectPath || projectPath.value || configStore.config.general?.backendProjectPath || "",
            currentModelDir: backendConfig.modelDir || configStore.config.general?.modelDir || "",
            selectedModelDir: selectedPath,
          }),
      });
      if (!pathsValid) {
        return;
      }

      backendConfig.modelDir = selectedPath;

      // 保存到配置文件
      const newConfig = { ...configStore.config };
      newConfig.general.modelDir = selectedPath;
      await persistConfig(newConfig);

      addTerminalLog(`模型路径设置成功：${selectedPath}`, "success");
    }
  } catch (error) {
    addTerminalLog(`选择模型路径失败：${error.message}`, "error");
  }
};
// 配置环境
const setupEnvironment = async () => {
  installing.dependencies = true;
  installProgress.value = 0;

  if (isBundledBackendMode.value && pythonEnvironmentSource.value === "managed") {
    addTerminalLog("开始创建或修复运行环境。", "info");
    try {
      const result = await updateManager.ensureRuntime({
        accelerator: managedAccelerator.value,
        force: ["failed", "needs-repair"].includes(updateManager.runtimeState.status),
      });
      if (result?.cancelled || result?.code === "ENVIRONMENT_PREPARATION_CANCELLED") {
        addTerminalLog("运行环境准备已取消，已启用的环境未受影响。", "warning");
        return result;
      }
      if (result?.success === false) {
        applyManagedEnvironmentState(result);
        if (result.capabilityWarning) {
          addTerminalLog(
            result.warning?.message || result.error || "当前显卡或驱动不满足所选运行环境要求，已保留现有可用环境。",
            "warning"
          );
          return result;
        }
        appendEnvironmentRecoveryGuidance(result);
        throw new Error(result?.error?.message || result?.message || result?.error || "运行环境准备失败。");
      }
      applyManagedEnvironmentState(result);
      await syncEnvironmentLaunchDevice(
        result?.state?.selectedAccelerator || updateManager.runtimeState.selectedAccelerator,
        { log: true }
      );
      addTerminalLog(
        updateManager.runtimeState.status === "degraded"
          ? "运行环境核心能力已就绪；应用内置 FFmpeg 未通过校验，视频能力暂不可用。"
          : `运行环境已就绪：${updateManager.runtimeState.activePath || "路径已确认"}`,
        updateManager.runtimeState.status === "degraded" ? "warning" : "success"
      );
      addTerminalLog("请点击左方启动服务按钮，以启动服务。", "success");
      return result;
    } catch (error) {
      addTerminalLog(`运行环境准备失败：${error.message}`, "error");
      return { success: false, error: error.message };
    } finally {
      installing.dependencies = false;
    }
  }

  addTerminalLog(
    isBundledBackendMode.value
      ? "正在准备本地运行环境..."
      : "Preparing Python environment...",
    "info"
  );
  addTerminalLog("开始配置运行环境...", "info");

  try {
    const prepareResult = await window.electron.ipcRenderer.invoke(
      "prepare-project-python",
      projectPath.value || backendConfig.projectPath
    );

    if (!prepareResult.success) {
      setEnvironmentItemState(["python", "venv"], "failure");
      setEnvironmentItemState("dependencies", "idle");
      appendProjectPathGuidance(prepareResult);
      appendEnvironmentRecoveryGuidance(prepareResult);
      if (prepareResult.manualGuide?.downloadUrl) {
        addTerminalLog(
          `手动下载链接：${prepareResult.manualGuide.downloadUrl}`,
          "warning"
        );
      }
      if (Array.isArray(prepareResult.manualGuide?.commands)) {
        addTerminalLog("手动执行命令：", "info");
        prepareResult.manualGuide.commands.forEach((command) => {
          addTerminalLog(command, "info");
        });
      }
      throw new Error(prepareResult.error || "Python 环境准备失败。");
    }

    environmentStatus.project = true;
    environmentStatus.python = true;
    environmentStatus.venv = true;
    setEnvironmentItemState(["project", "python", "venv"], "success");
    if (prepareResult.path) {
      projectPath.value = prepareResult.path;
    }
    pythonVersion.value = prepareResult.pythonVersion
      ? `Python ${prepareResult.pythonVersion}`
      : pythonVersion.value;
    venvStatus.value = `已就绪（${prepareResult.venvName || ".venv"}）`;
    addTerminalLog("虚拟环境已就绪。", "success");
    installProgress.value = 50;

    addTerminalLog("开始安装依赖...", "info");
    applyPreparedEnvironment(prepareResult);
    addTerminalLog(
      isBundledBackendMode.value
        ? "本地运行环境已就绪。"
        : "Virtual environment is ready.",
      "success"
    );
    addTerminalLog(
      isBundledBackendMode.value
        ? "正在校验内置服务依赖..."
        : "Installing dependencies...",
      "info"
    );

    const depsResult = await window.electron.ipcRenderer.invoke(
      "install-dependencies",
      projectPath.value || backendConfig.projectPath
    );

    if (depsResult.success) {
      applyDependenciesStatus(true);
      addTerminalLog(
        isBundledBackendMode.value
          ? "内置服务依赖已就绪。"
          : "依赖安装成功。",
        "success"
      );
      installProgress.value = 100;
      currentStep.value = 3;
    } else {
      applyDependenciesStatus(false);
      throw new Error(depsResult.error);
    }
  } catch (error) {
    addTerminalLog(`环境配置失败：${error.message}`, "error");
  } finally {
    installing.dependencies = false;
  }
};

// 启动服务
const startService = async () => {
  fallbackMatDefaultModelIfNeeded({ notify: true, log: true });
  const pathsValid = await ensureBackendPathsValid({
    backendProjectPath: backendConfig.projectPath || projectPath.value || "",
    modelDir: backendConfig.modelDir || "",
  });
  if (!pathsValid) {
    backendEngineStore.setStopped();
    return { success: false, error: "服务路径配置无效" };
  }

  serviceLoading.value = true;
  backendEngineStore.setPreparing("startingEngine");
  addTerminalLog(
    `启动服务... 端口：${backendConfig.port}，设备：${backendConfig.device}，模型：${backendConfig.model}`,
    "info"
  );

  try {
    const options = {
      port: backendConfig.port,
      device: backendConfig.device,
      model: backendConfig.model,
      modelDir: backendConfig.modelDir || "",
      samReleaseBeforeProcessing: backendConfig.samReleaseBeforeProcessing,
    };
    const startAction = getBackendEngineAction("start");
    let result;
    if (startAction) {
      result = await startAction(options, {
        onHealthCheckStart: () => {
          addTerminalLog("服务健康检查开始……", "success");
        },
      });
    } else {
      addTerminalLog("服务健康检查开始……", "success");
      result = await window.electron.ipcRenderer.invoke("start-backend-service", options);
    }

    if (result?.success && !startAction) {
      try {
        await modelRegistryStore.ensureModelReady(options.model || "lama");
      } catch (error) {
        const modelFailure = {
          success: false,
          code: error?.code || "DEFAULT_MODEL_PREPARATION_FAILED",
          error: error?.message || "默认模型校验或加载失败",
          processRunning: true,
        };
        backendEngineStore.setFailed(modelFailure);
        addTerminalLog(`默认模型准备失败：${modelFailure.error}`, "error");
        return modelFailure;
      }
    }

    if (result.success) {
      const actualPort = Number(result.port || backendConfig.port);
      if (result.effectiveAccelerator) {
        await syncEnvironmentLaunchDevice(result.effectiveAccelerator, { log: true });
      }
      await syncRuntimeBackendPort(actualPort);
      if (!startAction) {
        backendEngineStore.setRunning({
          ...result,
          port: actualPort,
          processRunning: true,
          ready: true,
        });
      }
      addTerminalLog(
        `服务启动成功，端口：${actualPort}`,
        "success"
      );
      addTerminalLog(
        `已更新前端 API 端口配置为: ${actualPort}`,
        "success"
      );
      addTerminalLog(
        "服务健康检查已通过，可以开始使用。",
        "success"
      );
    } else {
      backendEngineStore.setFailed(result);
      addTerminalLog(`服务启动失败：${result.error}`, "error");
      if (result.recoveryHint) {
        addTerminalLog(result.recoveryHint, "warning");
      }
    }
    return result;
  } catch (error) {
    backendEngineStore.setFailed(error?.message || "服务启动失败");
    addTerminalLog(`服务启动失败：${error.message}`, "error");
    return { success: false, error: error?.message || "服务启动失败" };
  } finally {
    serviceLoading.value = false;
  }
};

// 停止服务
const stopService = async () => {
  serviceLoading.value = true;
  backendEngineStore.setStopping({
    processRunning: backendEngineStore.processRunning,
  });
  addTerminalLog("停止服务...", "info");

  try {
    const stopAction = getBackendEngineAction("stop");
    const result = stopAction
      ? await stopAction()
      : await window.electron.ipcRenderer.invoke("stop-backend-service");

    if (backendEngineStore.applyStopResult(result)) {
      addTerminalLog(
        result?.cancelled ? "已取消正在进行的服务启动" : "服务已停止",
        "success"
      );
    } else {
      addTerminalLog(`停止服务失败：${result?.error || "未知错误"}`, "error");
      await checkServiceStatus();
      if (backendEngineStore.status === "stopping") {
        backendEngineStore.setFailed(result);
      }
    }
    return result;
  } catch (error) {
      addTerminalLog(`停止服务失败：${error.message}`, "error");
    await checkServiceStatus();
    if (backendEngineStore.status === "stopping") {
      backendEngineStore.setFailed(error?.message || "停止服务失败");
    }
    return { success: false, error: error?.message || "停止服务失败" };
  } finally {
    serviceLoading.value = false;
  }
};

// 重启服务
const restartService = async () => {
  fallbackMatDefaultModelIfNeeded({ notify: true, log: true });
  const restartAction = getBackendEngineAction("restart");
  if (!restartAction) {
    const stopResult = await stopService();
    if (stopResult?.success || !backendEngineStore.processRunning) {
      return await startService();
    }
    return stopResult;
  }

  serviceLoading.value = true;
  addTerminalLog("重启服务...", "info");
  try {
    const result = await restartAction({
      port: backendConfig.port,
      device: backendConfig.device,
      model: backendConfig.model,
      modelDir: backendConfig.modelDir || "",
      samReleaseBeforeProcessing: backendConfig.samReleaseBeforeProcessing,
    });
    addTerminalLog(
      result?.success ? "服务重启成功" : `服务重启失败：${result?.error}`,
      result?.success ? "success" : "error"
    );
    return result;
  } finally {
    serviceLoading.value = false;
  }
};

// 执行命令
const executeCommand = async () => {
  if (!terminalInput.value.trim()) return;

  const command = terminalInput.value.trim();
  terminalInput.value = "";
  commandExecuting.value = true;

  addTerminalLog(`$ ${command}`, "info");

  try {
    const result = await window.electron.ipcRenderer.invoke("execute-command", {
      command,
      cwd: projectPath.value,
    });

    if (result.success) {
      if (result.output) {
        addTerminalLog(result.output, "info");
      }
    } else {
      addTerminalLog(result.error, "error");
    }
  } catch (error) {
    addTerminalLog(`命令执行失败: ${error.message}`, "error");
  } finally {
    commandExecuting.value = false;
  }
};

// 组件挂载时检查环境
onMounted(() => {
  if (showDialog.value) {
    checkEnvironment({ syncServiceStatus: true });
  }
  if (window.electron && window.electron.ipcRenderer) {
    removeBackendOutputListener =
      window.electron.ipcRenderer.on('backend-output', handleBackendOutput) || null;
    removePythonInstallPathListener =
      window.electron.ipcRenderer.on('python-install-path', handlePythonInstallPath) || null;
  }
  if (typeof window !== "undefined" && window.__MOONSHINE_E2E__ === true) {
    window.__MOONSHINE_BACKEND_MANAGER_TEST__ = {
      addTerminalLog,
      queueTerminalLog,
      flushPendingTerminalLogs,
      getTerminalMessages: () => terminalOutput.value.map((line) => line.message),
      getTerminalLines: () =>
        terminalOutput.value.map((line) => ({
          message: line.message,
          type: line.type,
          progressKey: line.progressKey,
          progressActive: line.progressActive,
          hasProgressInfo: Boolean(line.progressInfo),
          refreshId: line.refreshId,
          timestamp: line.timestamp,
          className: getTerminalLineClass(line),
        })),
      getPendingTerminalCount: () => pendingTerminalLogs.length,
      getModelTaskPollSummary: () => ({
        count: modelTaskPollCount,
        taskCount: modelTaskPollIds.size,
        message: modelTaskPollSummaryLine?.message || "",
      }),
      getFlushIntervalMs: () => TERMINAL_PROGRESS_SYNC_MAX_MS,
      getFlushIntervalRangeMs: () => ({
        min: TERMINAL_PROGRESS_SYNC_MIN_MS,
        max: TERMINAL_PROGRESS_SYNC_MAX_MS,
      }),
      getProgressHeartbeatMs: () => TERMINAL_PROGRESS_HEARTBEAT_MS,
      getEnvironmentCheckSnapshot: () => ({
        checking: checking.value,
        completed: environmentCheckCompleted.value,
        inFlight: Boolean(environmentCheckPromise),
        error: environmentStatus.error,
        itemStates: { ...environmentItemStates },
      }),
      setServiceTestStatus: async (status = "stopped") => {
        if (status === "running") {
          backendEngineStore.setRunning({ processRunning: true, healthReady: true });
        } else {
          backendEngineStore.setStopped({ processRunning: false, healthReady: false });
        }
        await nextTick();
        return serviceStatus.value;
      },
      startEnvironmentCheck: (options = {}) => {
        void checkEnvironment(options);
        return {
          checking: checking.value,
          completed: environmentCheckCompleted.value,
          inFlight: Boolean(environmentCheckPromise),
          itemStates: { ...environmentItemStates },
        };
      },
      getEnvironmentItemStates: () => ({ ...environmentItemStates }),
      setEnvironmentItemStates: async (states = {}) => {
        Object.entries(states).forEach(([item, state]) => {
          setEnvironmentItemState(item, state);
        });
        await nextTick();
        return { ...environmentItemStates };
      },
      clearTerminal,
    };
  }
});
onUnmounted(() => {
  removeBackendOutputListener?.();
  removeBackendOutputListener = null;
  removePythonInstallPathListener?.();
  removePythonInstallPathListener = null;
  if (typeof window !== "undefined" && window.__MOONSHINE_BACKEND_MANAGER_TEST__) {
    delete window.__MOONSHINE_BACKEND_MANAGER_TEST__;
  }
  if (terminalFlushTimerId) {
    window.clearTimeout(terminalFlushTimerId);
    terminalFlushTimerId = 0;
  }
  stopServiceProcessPolling();
  clearTerminalProgressHeartbeat();
});
</script>

<style scoped>
/* 后端管理对话框层级 - 最高层级 */
.backend-dialog {
  z-index: 3000 !important;
}

:deep(.backend-dialog .q-dialog) {
  z-index: 3000 !important;
}

:deep(.backend-dialog .q-dialog__backdrop) {
  z-index: 3000 !important;
}

.backend-manager-card {
  width: 90vw;
  height: 80vh;
  max-width: 1600px;
  max-height: 1000px;
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  box-shadow: 0 12px 24px rgba(0, 0, 0, 0.15);
  transition: background-color 0.2s ease, color 0.2s ease;
}

.backend-manager-card--light {
  background: #ffffff;
  color: rgba(17, 24, 39, 0.94);
}

.backend-manager-card--dark {
  background: #121212;
  color: rgba(244, 244, 245, 0.94);
}

.backend-content {
  flex: 1 1 auto;
  min-height: 0;
  height: calc(80vh - 60px);
  max-height: calc(1000px - 60px);
  overflow: hidden;
}

.full-height {
  height: 100%;
}

.control-panel {
  display: flex;
  min-width: 0;
  overflow: hidden;
  transition: background-color 0.2s ease, color 0.2s ease, border-color 0.2s ease;
}

.backend-stepper {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
}

:deep(.backend-content .q-splitter__before),
:deep(.backend-content .q-splitter__after) {
  min-width: 0;
  overflow: hidden;
}

.control-panel--light {
  background: #f5f5f5;
  border-right: 1px solid #e0e0e0;
  color: rgba(17, 24, 39, 0.94);
}

.control-panel--dark {
  background: #1d1d1d;
  border-right: 1px solid rgba(255, 255, 255, 0.08);
  color: rgba(244, 244, 245, 0.94);
}

.runtime-path-feedback {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}

.runtime-path-feedback > .q-icon,
.runtime-path-feedback > .text-grey-7 {
  flex: 0 0 auto;
  white-space: nowrap;
}

.runtime-path-feedback__value {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: ltr;
}

.service-management-panel {
  display: grid;
  gap: 14px;
}

.service-overview,
.service-configuration {
  min-width: 0;
  padding: 14px;
  border: 1px solid rgba(17, 24, 39, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.62);
}

.backend-manager-card--dark .service-overview,
.backend-manager-card--dark .service-configuration {
  border-color: rgba(255, 255, 255, 0.1);
  background: rgba(255, 255, 255, 0.035);
}

.service-overview__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  margin-bottom: 12px;
}

.service-status-chip {
  flex: 0 0 auto;
  margin: 0;
}

.service-info-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px 14px;
  margin: 0;
}

.service-info-item {
  min-width: 0;
  padding: 9px 10px;
  border-radius: 6px;
  background: rgba(125, 125, 125, 0.08);
}

.service-info-item dt {
  margin-bottom: 2px;
  color: rgba(75, 85, 99, 0.8);
  font-size: 12px;
}

.backend-manager-card--dark .service-info-item dt {
  color: rgba(229, 231, 235, 0.68);
}

.service-info-item dd {
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--q-primary);
  font-weight: 500;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.service-config-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}

.service-config-grid > :nth-child(3),
.service-config-grid > .model-management-notice,
.service-config-grid > .q-field:last-child {
  grid-column: 1 / -1;
}

.model-management-notice {
  border: 1px solid rgba(25, 118, 210, 0.2);
  background: rgba(25, 118, 210, 0.08);
  color: var(--q-primary);
}

.model-management-notice__content {
  display: flex;
  align-items: center;
  gap: 10px;
}

.model-management-notice__content > span {
  min-width: 0;
  flex: 1 1 auto;
}

.service-controls {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
  width: min(100%, 480px);
  margin: 16px auto 0;
}

.service-controls--single {
  grid-template-columns: minmax(0, 320px);
  justify-content: center;
}

.service-control-button {
  width: 100%;
  min-width: 0;
}

.service-control-button :deep(.q-btn__content) {
  min-width: 0;
  white-space: normal;
}

@media (max-width: 900px) {
  .service-management-panel {
    gap: 10px;
  }

  .service-overview,
  .service-configuration {
    padding: 10px;
  }
}

@media (max-width: 640px) {
  .service-info-grid,
  .service-config-grid {
    grid-template-columns: 1fr;
  }

  .service-config-grid > :nth-child(3),
  .service-config-grid > .model-management-notice,
  .service-config-grid > .q-field:last-child {
    grid-column: auto;
  }

  .model-management-notice__content {
    align-items: stretch;
    flex-direction: column;
  }

  .service-controls {
    grid-template-columns: minmax(0, 1fr);
  }
}

.control-panel::-webkit-scrollbar {
  width: 6px;
}

.control-panel--light::-webkit-scrollbar-track {
  background: #f5f5f5;
}

.control-panel--light::-webkit-scrollbar-thumb {
  background: #c0c0c0;
  border-radius: 3px;
}

.control-panel--light::-webkit-scrollbar-thumb:hover {
  background: #a0a0a0;
}

.terminal-section {
  background: linear-gradient(135deg, #1a1a1a 0%, #2d2d2d 100%);
  display: flex;
  flex-direction: column;
  color: white;
  min-width: 0;
  min-height: 0;
}

.terminal-header {
  padding: 16px;
  background: rgba(255, 255, 255, 0.05);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
  display: flex;
  align-items: center;
  color: #4ade80;
  flex-shrink: 0;
}

.terminal-output {
  flex: 1 1 auto;
  min-width: 0;
  min-height: 0;
  overflow-x: hidden;
  overflow-y: auto;
  padding: 16px;
  font-family: "Courier New", "Monaco", "Menlo", monospace;
  font-size: 13px;
  line-height: 1.5;
  background: rgba(0, 0, 0, 0.3);
  margin: 8px;
  border-radius: 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
}

.terminal-line {
  margin-bottom: 2px;
  word-wrap: break-word;
}

.diagnostic-value {
  min-width: 0;
  overflow-wrap: anywhere;
  user-select: text;
}

.diagnostic-output {
  max-height: 160px;
  margin: 0;
  padding: 8px;
  overflow: auto;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  border-radius: 4px;
  background: rgba(0, 0, 0, 0.08);
  color: inherit;
  font-family: Consolas, "Courier New", monospace;
  font-size: 12px;
  line-height: 1.5;
  user-select: text;
}
.terminal-line--info {
  color: #ffffff;
}
.terminal-line--error {
  color: #ff6b6b;
}
.terminal-line--warning {
  color: #ffd166;
}
.terminal-line--success {
  color: #4ade80;
}
.terminal-line--progress {
  color: var(--q-accent);
}
.terminal-line--progress-complete {
  color: var(--q-accent);
}

.terminal-output::-webkit-scrollbar {
  width: 8px;
}

.terminal-output::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.terminal-output::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.3);
  border-radius: 4px;
}

.terminal-output::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.5);
}

.terminal-input {
  padding: 16px;
  display: flex;
  align-items: center;
  background: rgba(255, 255, 255, 0.05);
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  flex-shrink: 0;
}

.control-panel--dark::-webkit-scrollbar-track {
  background: rgba(255, 255, 255, 0.04);
}

.control-panel--dark::-webkit-scrollbar-thumb {
  background: rgba(255, 255, 255, 0.18);
}

.control-panel--dark::-webkit-scrollbar-thumb:hover {
  background: rgba(255, 255, 255, 0.28);
}

.control-panel--dark :deep(.q-stepper),
.control-panel--dark :deep(.q-stepper__step-inner),
.control-panel--dark :deep(.q-stepper__nav),
.control-panel--dark :deep(.q-card) {
  background: #1d1d1d;
  color: rgba(244, 244, 245, 0.94);
}

.control-panel--dark :deep(.q-card) {
  border-color: rgba(255, 255, 255, 0.08);
}

.control-panel--dark :deep(.q-banner) {
  background: rgba(59, 130, 246, 0.16) !important;
  color: rgba(191, 219, 254, 0.98) !important;
}

.control-panel--dark :deep(.q-item__label),
.control-panel--dark :deep(.text-grey-8),
.control-panel--dark :deep(.text-grey-7),
.control-panel--dark :deep(.text-grey-6) {
  color: rgba(228, 228, 231, 0.9) !important;
}

.control-panel--dark :deep(.q-field__control),
.control-panel--dark :deep(.q-field__native),
.control-panel--dark :deep(.q-field__input) {
  color: rgba(244, 244, 245, 0.94);
}

.control-panel--dark :deep(.q-field--outlined .q-field__control) {
  background: rgba(255, 255, 255, 0.04);
}

.control-panel--dark :deep(.q-field__marginal),
.control-panel--dark :deep(.q-stepper__title),
.control-panel--dark :deep(.q-stepper__caption) {
  color: rgba(228, 228, 231, 0.88);
}

/* 响应式设计 */
@media (max-width: 1200px) {
  .backend-dialog .q-dialog__inner {
    padding: 2vh 2vw;
  }

  .backend-manager-card {
    width: 96vw;
    height: 96vh;
  }

  .backend-content {
    height: calc(96vh - 60px);
  }
}

@media (max-width: 768px) {
  .backend-dialog .q-dialog__inner {
    padding: 1vh 1vw;
  }

  .backend-manager-card {
    width: 98vw;
    height: 98vh;
  }

  .backend-content {
    height: calc(98vh - 60px);
  }

  .control-panel {
    padding: 8px;
  }

  :deep(.backend-content .q-splitter__before),
  :deep(.backend-content .q-splitter__after) {
    min-height: 0;
  }

  .terminal-header,
  .terminal-input {
    padding: 10px;
  }

  .terminal-output {
    margin: 6px;
    padding: 10px;
  }
}
</style>

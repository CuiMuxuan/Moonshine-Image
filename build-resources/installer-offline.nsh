; The outer offline ZIP places offline-payload beside this NSIS executable.
; Keep only a location receipt in the installed directory: the application
; verifies every payload file before importing it into userData.
; electron-builder compiles the installer and uninstaller in separate passes;
; the installer pass sees custom uninstall code without WriteUninstaller.
!pragma warning disable 6020
!macro customInstall
  IfFileExists "$EXEDIR\offline-payload\payload-manifest.json" offline_payload_found offline_payload_done
offline_payload_found:
  FileOpen $0 "$INSTDIR\offline-payload-source.txt" w
  FileWrite $0 "$EXEDIR\offline-payload"
  FileClose $0
offline_payload_done:
!macroend

!include nsDialogs.nsh

Var /GLOBAL unDeleteConfig
Var /GLOBAL unDeleteManagedEnvironment
Var /GLOBAL unDeleteConfigCheckbox
Var /GLOBAL unDeleteManagedEnvironmentCheckbox

; electron-builder places customUnWelcomePage before the uninstall section,
; allowing the selected options to affect cleanup below.
!macro customUnWelcomePage
  !insertmacro MUI_UNPAGE_WELCOME
  UninstPage custom un.CleanupOptionsCreate un.CleanupOptionsLeave
!macroend

!macro customUnInit
  StrCpy $unDeleteConfig "0"
  StrCpy $unDeleteManagedEnvironment "0"

  ; An updater invokes the uninstaller silently. It must never remove user
  ; configuration or a managed environment, even if flags were supplied.
  ${IfNot} ${isUpdated}
    ${GetParameters} $0

    ClearErrors
    ${GetOptions} $0 "--delete-config" $1
    ${IfNot} ${Errors}
      StrCpy $unDeleteConfig "1"
    ${EndIf}

    ClearErrors
    ${GetOptions} $0 "--delete-managed-environment" $1
    ${IfNot} ${Errors}
      StrCpy $unDeleteManagedEnvironment "1"
    ${EndIf}
  ${EndIf}
!macroend

Function un.CleanupOptionsCreate
  ${If} ${isUpdated}
    Abort
  ${EndIf}

  nsDialogs::Create 1018
  Pop $0
  ${If} $0 == error
    Abort
  ${EndIf}

  ${NSD_CreateLabel} 0u 0u 100% 22u "Both options are off by default. Models, logs, downloads, temporary files, results, and external Python environments are kept."
  Pop $0

  ${NSD_CreateCheckbox} 0u 34u 100% 18u "Delete Moonshine-Image configuration and saved settings"
  Pop $unDeleteConfigCheckbox
  ${If} $unDeleteConfig == "1"
    ${NSD_SetState} $unDeleteConfigCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $unDeleteConfigCheckbox ${BST_UNCHECKED}
  ${EndIf}

  ${NSD_CreateCheckbox} 0u 60u 100% 26u "Delete the managed Moonshine-Image runtime environment and runtime caches"
  Pop $unDeleteManagedEnvironmentCheckbox
  ${If} $unDeleteManagedEnvironment == "1"
    ${NSD_SetState} $unDeleteManagedEnvironmentCheckbox ${BST_CHECKED}
  ${Else}
    ${NSD_SetState} $unDeleteManagedEnvironmentCheckbox ${BST_UNCHECKED}
  ${EndIf}

  nsDialogs::Show
FunctionEnd

Function un.CleanupOptionsLeave
  ${If} ${isUpdated}
    Return
  ${EndIf}

  ${NSD_GetState} $unDeleteConfigCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $unDeleteConfig "1"
  ${Else}
    StrCpy $unDeleteConfig "0"
  ${EndIf}

  ${NSD_GetState} $unDeleteManagedEnvironmentCheckbox $0
  ${If} $0 == ${BST_CHECKED}
    StrCpy $unDeleteManagedEnvironment "1"
  ${Else}
    StrCpy $unDeleteManagedEnvironment "0"
  ${EndIf}
FunctionEnd

!macro customUnInstall
  ${If} ${isUpdated}
    Goto moonshine_cleanup_done
  ${EndIf}

  ; Electron user data is always owned by the interactive user, including an
  ; all-users installation. Restore the all-users context when finished.
  ${If} $installMode == "all"
    SetShellVarContext current
  ${EndIf}

  ${If} $unDeleteConfig == "1"
    ; Configuration-only cleanup: do not remove the enclosing userData root.
    RMDir /r /REBOOTOK "$APPDATA\Moonshine-Image\config"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\app-state.json"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\environments\preference.json"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\environments\external.json"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\runtime\channel.json"
    Delete /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\channel.json"
  ${EndIf}

  ${If} $unDeleteManagedEnvironment == "1"
    ; Managed paths only. Never follow external environment configuration or
    ; remove model, log, download, temporary, or user-result directories.
    RMDir /r /REBOOTOK "$APPDATA\Moonshine-Image\environments\win-x64"
    RMDir /r /REBOOTOK "$APPDATA\Moonshine-Image\environments\.staging"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\environments\active.json"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\environments\history.json"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\environments\last-failure.json"
    Delete /REBOOTOK "$APPDATA\Moonshine-Image\diagnostics\effective-runtime.json"
    RMDir /r /REBOOTOK "$APPDATA\Moonshine-Image\runtime"

    RMDir /r /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\runtimes"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\staging"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\downloads"
    RMDir /r /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\ffmpeg"
    Delete /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\active.json"
    Delete /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\verified-manifest.json"
    Delete /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\verified-model-manifest.json"
    Delete /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components\runtime.lock"
    RMDir /REBOOTOK "$LOCALAPPDATA\Moonshine-Image\components"
  ${EndIf}

  ${If} $installMode == "all"
    SetShellVarContext all
  ${EndIf}

moonshine_cleanup_done:
!macroend

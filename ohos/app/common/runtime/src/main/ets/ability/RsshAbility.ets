import { BackgroundMode, backgroundTaskManager } from '@kit.BackgroundTasksKit';
import { common, Want, WantAgent, wantAgent } from '@kit.AbilityKit';
import { BusinessError } from '@kit.BasicServicesKit';
import { NativeAbility } from '@ohos-rs/ability';
import { window } from '@kit.ArkUI';
import { rsshPlugins } from './RsshPlugins';

const CONTINUOUS_TASK_LOG_TAG = '[RsshAbility]';

export class RsshAbility extends NativeAbility {
  public moduleName: string = 'rssh_ohos';
  public bridgePlugins = rsshPlugins(true);
  private continuousTaskStarting: Promise<void> | null = null;
  private continuousTaskActive: boolean = false;
  private continuousTaskCancelRegistered = false;

  protected override async loadWindowStageContent(windowStage: window.WindowStage): Promise<void> {
    // This mobile HAP serves both phones and tablets; desktop has its own Ability.
    // ArkWeb exposes cutout insets to CSS without reserving a native top strip.
    // Keep keyboard and navigation-bar avoidance in ArkUI.
    try {
      const mainWindow = await windowStage.getMainWindow();
      await mainWindow.setSpecificSystemBarEnabled('status', false);
    } catch (error) {
      console.error(`${CONTINUOUS_TASK_LOG_TAG} Failed to hide mobile status bar: ${String(error)}`);
    }
    await windowStage.loadContent('pages/Index');
  }

  protected override createInitContext(moduleName: string) {
    const context = super.createInitContext(moduleName);
    // Keep existing databases and keys in ApplicationContext's /base/files.
    // https://github.com/openharmony/docs/blob/master/en/application-dev/application-models/application-context-stage.md#obtaining-application-file-paths
    const filesDir = this.context.getApplicationContext().filesDir;
    context.basePath = filesDir;
    context.prefPath = filesDir;
    return context;
  }

  /**
   * Keep the process scheduled while a port forward is active in the background.
   * The RSSH engine keeps its forwards in the native runtime regardless of window
   * visibility; the continuous task only prevents HarmonyOS from suspending that
   * runtime. MULTI_DEVICE_CONNECTION matches a persistent SSH connection: unlike
   * DATA_TRANSFER it has no progress-notification requirement, so an idle
   * forwarding tunnel keeps its task instead of being cancelled after ten idle
   * minutes (SYSTEM_CANCEL_DATA_TRANSFER_NOT_UPDATE / _LOW_SPEED).
   */
  onBackground(): void {
    super.onBackground();
    void this.startContinuousTask();
  }

  onForeground(): void {
    void this.releaseContinuousTask().catch((error: BusinessError) => {
      console.warn(`${CONTINUOUS_TASK_LOG_TAG} Failed to release continuous task: ${String(error)}`);
    });
    super.onForeground();
  }

  onDestroy(): Promise<void> {
    const destroyed = super.onDestroy();
    void this.releaseContinuousTask().catch((error: BusinessError) => {
      console.warn(`${CONTINUOUS_TASK_LOG_TAG} Failed to release continuous task: ${String(error)}`);
    });
    return destroyed;
  }

  private async startContinuousTask(): Promise<void> {
    if (this.continuousTaskActive) return;
    if (this.continuousTaskStarting) {
      await this.continuousTaskStarting;
      return;
    }
    this.registerCancelListener();
    const starting = this.createWantAgent()
      .then((agent: WantAgent) => backgroundTaskManager.startBackgroundRunning(
        this.context as common.UIAbilityContext,
        BackgroundMode.MULTI_DEVICE_CONNECTION,
        agent,
      ))
      .then(() => {
        this.continuousTaskActive = true;
        console.info(`${CONTINUOUS_TASK_LOG_TAG} Background data-transfer task started`);
      })
      .catch((error: BusinessError) => {
        // The task is best-effort: a rejection must not break the UI lifecycle.
        console.warn(`${CONTINUOUS_TASK_LOG_TAG} Background task unavailable: ${error.code} ${error.message}`);
      })
      .finally(() => {
        this.continuousTaskStarting = null;
      });
    this.continuousTaskStarting = starting;
    await starting;
  }

  /**
   * The system can revoke the task behind our back — idle-timeout enforcement,
   * or the user swiping the continuous-task notification away. Reset the flag
   * so the next onBackground() requests a fresh task instead of skipping it.
   */
  private registerCancelListener(): void {
    if (this.continuousTaskCancelRegistered) return;
    try {
      backgroundTaskManager.on('continuousTaskCancel', (info: backgroundTaskManager.ContinuousTaskCancelInfo) => {
        if (this.continuousTaskActive) {
          this.continuousTaskActive = false;
          console.warn(`${CONTINUOUS_TASK_LOG_TAG} Background task cancelled by system: ${info.reason}`);
        }
      });
      this.continuousTaskCancelRegistered = true;
    } catch (error) {
      console.warn(`${CONTINUOUS_TASK_LOG_TAG} Cancel listener unavailable: ${String(error)}`);
    }
  }

  private async releaseContinuousTask(): Promise<void> {
    if (this.continuousTaskStarting) {
      await this.continuousTaskStarting;
    }
    if (!this.continuousTaskActive) return;
    this.continuousTaskActive = false;
    await backgroundTaskManager.stopBackgroundRunning(this.context as common.UIAbilityContext);
    console.info(`${CONTINUOUS_TASK_LOG_TAG} Background data-transfer task stopped`);
  }

  private async createWantAgent(): Promise<WantAgent> {
    const want: Want = {
      bundleName: 'com.rssh.app',
      moduleName: 'entry',
      abilityName: 'EntryAbility',
    };
    const info: wantAgent.WantAgentInfo = {
      wants: [want],
      actionType: wantAgent.OperationType.START_ABILITY,
      requestCode: 0,
      wantAgentFlags: [wantAgent.WantAgentFlags.UPDATE_PRESENT_FLAG],
    };
    return await wantAgent.getWantAgent(info);
  }
}

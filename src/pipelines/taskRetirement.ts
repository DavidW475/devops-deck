/**
 * Built-in tasks that Microsoft retires, from the Learn article "Azure Pipelines task retirement announcement". It applies
 * to Azure DevOps Services only and goes stale: after the removal date it matters little.
 */
import { RetiredTask } from './taskModel';

export const RETIREMENT_SOURCE = 'https://learn.microsoft.com/en-us/azure/devops/pipelines/tasks/task-retirement';
/** Date of the article version the table was copied from (its `ms.date`). */
export const RETIREMENT_AS_OF = '2026-10-28';

const RETIRES = '2026-11-24';
const REMOVED = '2027-03-15';

/**
 * `[task, major, replacement]`. The replacement is set only when the article names exactly one task version; entries
 * whose advice is prose or several tasks (e.g. "NuGetCommand@2 with the push command") have none.
 */
const TABLE: [string, number, string?][] = [
  ['AndroidSigning', 2, 'AndroidSigning@3'],
  ['AppCenterDistribute', 1],
  ['AppCenterDistribute', 2],
  ['AutomatedAnalysis', 0],
  ['AzureCloudPowerShellDeployment', 1, 'AzurePowerShell@5'],
  ['AzureCloudPowerShellDeployment', 2, 'AzurePowerShell@5'],
  ['AzureMonitor', 0, 'AzureMonitor@1'],
  ['AzureNLBManagement', 1],
  ['CacheBeta', 0, 'Cache@2'],
  ['Chef', 1],
  ['ChefKnife', 1],
  ['CondaEnvironment', 1],
  ['DotNetCoreInstaller', 0, 'UseDotNet@2'],
  ['DotNetCoreInstaller', 1, 'UseDotNet@2'],
  ['DownloadPackage', 0, 'DownloadPackage@1'],
  ['DownloadPipelineArtifact', 0, 'DownloadPipelineArtifact@2'],
  ['DuffleInstaller', 0],
  ['FtpUpload', 1, 'FtpUpload@2'],
  ['GitHubRelease', 0, 'GitHubRelease@1'],
  ['Maven', 2, 'Maven@4'],
  ['MysqlDeploymentOnMachineGroup', 1],
  ['NuGet', 0, 'NuGetCommand@2'],
  ['NuGetInstaller', 0],
  ['NuGetPackager', 0],
  ['NuGetPublisher', 0],
  ['NuGetRestore', 1],
  ['PackerBuild', 0, 'PackerBuild@1'],
  ['PowerShellOnTargetMachines', 1, 'PowerShellOnTargetMachines@3'],
  ['PyPIPublisher', 0],
  ['QuickPerfTest', 1, 'AzureLoadTest@1'],
  ['ServiceFabricComposeDeploy', 0, 'ServiceFabricDeploy@1'],
  ['XamarinAndroid', 1],
  ['XamariniOS', 2],
  ['XamarinTestCloud', 1],
  // Legacy built-in tasks
  ['AndroidBuild', 1, 'Gradle@4'],
  ['AndroidSigning', 1, 'AndroidSigning@3'],
  ['AppCenterDistribute', 0],
  ['ArchiveFiles', 1, 'ArchiveFiles@2'],
  ['AzureCLI', 0, 'AzureCLI@3'],
  ['AzureFunction', 0, 'AzureFunction@2'],
  ['AzurePowerShell', 1, 'AzurePowerShell@5'],
  ['AzureResourceGroupDeployment', 1, 'AzureResourceGroupDeployment@2'],
  ['AzureRmWebAppDeployment', 2, 'AzureRmWebAppDeployment@5'],
  ['AzureWebPowerShellDeployment', 1, 'AzureRmWebAppDeployment@5'],
  ['CmdLine', 1, 'CmdLine@2'],
  ['CopyFiles', 1, 'CopyFiles@2'],
  ['CopyPublishBuildArtifacts', 1],
  ['cURLUploader', 1, 'cURLUploader@2'],
  ['DeployVisualStudioTestAgent', 1, 'VSTest@3'],
  ['DotNetCoreCLI', 0, 'DotNetCoreCLI@2'],
  ['DotNetCoreCLI', 1, 'DotNetCoreCLI@2'],
  ['Gradle', 1, 'Gradle@4'],
  ['InstallAppleCertificate', 0, 'InstallAppleCertificate@2'],
  ['InstallAppleCertificate', 1, 'InstallAppleCertificate@2'],
  ['InstallAppleProvisioningProfile', 0, 'InstallAppleProvisioningProfile@1'],
  ['InvokeRESTAPI', 0, 'InvokeRESTAPI@1'],
  ['JenkinsQueueJob', 1, 'JenkinsQueueJob@2'],
  ['Maven', 1, 'Maven@4'],
  ['PowerShell', 1, 'PowerShell@2'],
  ['PublishSymbols', 1, 'PublishSymbols@2'],
  ['PublishToAzureServiceBus', 0, 'PublishToAzureServiceBus@2'],
  ['RunVisualStudioTestsusingTestAgent', 1, 'VSTest@3'],
  ['ServiceFabricUpdateAppVersions', 1, 'ServiceFabricUpdateManifests@2'],
  ['SonarQubePostTest', 1],
  ['SonarQubePreBuild', 1],
  ['VSMobileCenterTest', 0],
  ['XamarinComponentRestore', 0],
  ['XamariniOS', 1],
  ['XamarinLicense', 1],
  ['Xcode', 2, 'Xcode@5'],
  ['Xcode', 3, 'Xcode@5'],
  ['Xcode', 4, 'Xcode@5'],
  ['XcodePackageiOS', 0, 'Xcode@5'],
];

const BY_KEY = new Map<string, RetiredTask>(TABLE.map(([name, major, replacement]) => [
  `${name.toLowerCase()}@${major}`,
  { name, major, retires: RETIRES, removed: REMOVED, replacement },
]));

/** The retirement entry of a task major, or undefined when Microsoft doesn't list it. The name compares case-insensitively. */
export function retirementOf(name: string, major: number): RetiredTask | undefined {
  return BY_KEY.get(`${name.toLowerCase()}@${major}`);
}

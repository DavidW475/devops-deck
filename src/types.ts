export interface IdentityRef {
  id: string;
  displayName: string;
  uniqueName?: string;
  imageUrl?: string;
}

export interface Reviewer extends IdentityRef {
  vote: number;
  isRequired?: boolean;
  isContainer?: boolean;
  hasDeclined?: boolean;
}

export interface GitRepositoryRef {
  id: string;
  name: string;
  webUrl?: string;
  project?: { id: string; name: string };
}

export interface PullRequest {
  pullRequestId: number;
  title: string;
  description?: string;
  status: string;
  isDraft?: boolean;
  createdBy: IdentityRef;
  creationDate: string;
  sourceRefName: string;
  targetRefName: string;
  repository: GitRepositoryRef;
  reviewers: Reviewer[];
  mergeStatus?: string;
  lastMergeSourceCommit?: { commitId: string };
  lastMergeCommit?: { commitId: string };
  closedDate?: string;
  closedBy?: IdentityRef;
  autoCompleteSetBy?: IdentityRef;
  completionOptions?: PrCompletionOptions;
}

export interface PrCompletionOptions {
  mergeStrategy?: string;
  deleteSourceBranch?: boolean;
  transitionWorkItems?: boolean;
  mergeCommitMessage?: string;
}

/** Pull requests of one commit: those that created it as their merge commit, and those that merged it. */
export interface CommitPrQueryResult {
  byMergeCommit: PullRequest[];
  byCommit: PullRequest[];
}

/** A person or group found with the identity picker. */
export interface Identity extends IdentityRef {
  isGroup?: boolean;
  mail?: string;
}

export interface PrIteration {
  id: number;
  description?: string;
  author?: IdentityRef;
  createdDate?: string;
  reason?: string;
  sourceRefCommit?: { commitId: string };
  commits?: GitCommitRef[];
}

export interface GitCommitRef {
  commitId: string;
  comment?: string;
  author?: { name: string; email?: string; date: string };
}

export interface GitRepository {
  id: string;
  name: string;
  defaultBranch?: string;
  remoteUrl?: string;
  sshUrl?: string;
  webUrl?: string;
  size?: number;
  isDisabled?: boolean;
  project?: { id: string; name: string };
}

export interface BranchStats {
  name: string;
  aheadCount: number;
  behindCount: number;
  isBaseVersion?: boolean;
  commit: GitCommitRef;
}

/** One file of a commit diff (branch comparison). */
export interface GitChange {
  changeType: string;
  item: { path: string; objectId?: string; originalObjectId?: string; gitObjectType?: string; isFolder?: boolean };
  originalPath?: string;
}

export interface PrChange {
  changeTrackingId: number;
  changeType: string;
  item: { path: string; objectId?: string; originalObjectId?: string; gitObjectType?: string; isFolder?: boolean };
  originalPath?: string;
}

export interface FilePosition {
  line: number;
  offset: number;
}

export interface PrComment {
  id: number;
  parentCommentId: number;
  author: IdentityRef;
  content?: string;
  publishedDate: string;
  commentType: string | number;
  isDeleted?: boolean;
}

export interface PrThreadContext {
  filePath: string;
  rightFileStart?: FilePosition;
  rightFileEnd?: FilePosition;
  leftFileStart?: FilePosition;
  leftFileEnd?: FilePosition;
}

export interface PrThread {
  id: number;
  status?: string | number;
  isDeleted?: boolean;
  publishedDate?: string;
  comments: PrComment[];
  threadContext?: PrThreadContext | null;
}

export interface WorkItem {
  id: number;
  rev: number;
  fields: Record<string, any>;
  relations?: WorkItemRelation[];
}

export interface WorkItemRelation {
  rel: string;
  url: string;
  attributes?: { name?: string; comment?: string };
}

export interface WorkItemUpdate {
  id: number;
  rev: number;
  revisedBy?: IdentityRef;
  revisedDate?: string;
  relations?: { added?: WorkItemRelation[]; removed?: WorkItemRelation[] };
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
}

export interface WorkItemComment {
  id: number;
  text: string;
  createdBy: IdentityRef;
  createdDate: string;
}

export interface WorkItemTypeField {
  referenceName: string;
  name: string;
  allowedValues?: string[];
  alwaysRequired?: boolean;
}

export interface WorkItemState {
  name: string;
  color: string;
  category: string;
}

export interface QueryItem {
  id: string;
  name: string;
  path: string;
  isFolder?: boolean;
  hasChildren?: boolean;
  children?: QueryItem[];
}

export interface BuildDefinition {
  id: number;
  name: string;
  path: string;
  repository?: { id?: string; type?: string; defaultBranch?: string; name?: string };
  latestBuild?: Build;
  /** type 2 = YAML, 1 = classic designer */
  process?: { type: number; yamlFilename?: string };
  variables?: Record<string, { value?: string; allowOverride?: boolean; isSecret?: boolean }>;
}

export interface Build {
  id: number;
  buildNumber: string;
  status: string;
  result?: string;
  definition: { id: number; name: string };
  sourceBranch: string;
  sourceVersion?: string;
  requestedFor?: IdentityRef;
  queueTime?: string;
  startTime?: string;
  finishTime?: string;
  reason?: string;
  /** often empty in list answers */
  repository?: { defaultBranch?: string };
}

export interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
  /** stage or job name as written in the YAML (e.g. "Build"); used for dependencies and stage retries */
  identifier?: string | null;
  state?: string;
  result?: string | null;
  startTime?: string | null;
  finishTime?: string | null;
  order?: number;
  log?: { id: number } | null;
  errorCount?: number;
  warningCount?: number;
  issues?: { type: string; message: string }[] | null;
}

export interface BuildLog {
  id: number;
  lineCount?: number;
}

export interface PolicyEvaluation {
  evaluationId: string;
  /** queued | running | approved | rejected | notApplicable | broken */
  status: string;
  configuration: {
    isEnabled: boolean;
    isBlocking: boolean;
    type: { id: string; displayName: string };
    settings?: { displayName?: string | null; buildDefinitionId?: number; statusName?: string; defaultDisplayName?: string };
  };
  context?: { buildId?: number; buildDefinitionName?: string; isExpired?: boolean } | null;
}

export interface TeamRef {
  id: string;
  name: string;
}

export interface TeamIteration {
  id: string;
  name: string;
  path: string;
  attributes?: { startDate?: string | null; finishDate?: string | null; timeFrame?: string };
}

export interface IterationWorkItemLink {
  rel?: string | null;
  source?: { id: number } | null;
  target?: { id: number } | null;
}

export interface TeamMemberCapacity {
  teamMember: IdentityRef;
  activities: { capacityPerDay: number; name?: string }[];
  daysOff: { start: string; end: string }[];
}

export interface ClassificationNode {
  name: string;
  hasChildren?: boolean;
  children?: ClassificationNode[];
  attributes?: { startDate?: string; finishDate?: string };
}

/** An iteration with its full path, as work items name it in System.IterationPath. */
export interface ClassificationIteration {
  path: string;
  finishDate?: string;
}

export interface Approval {
  id: string;
  status: string;
  createdOn?: string;
  instructions?: string;
  minRequiredApprovers?: number;
  blockedApprovers?: IdentityRef[];
  steps?: { assignedApprover: IdentityRef; status: string; comment?: string }[];
  pipeline?: { id?: number | string; name?: string; owner?: { id: number; name?: string } };
}

export interface BuildArtifact {
  id: number;
  name: string;
  resource?: { type?: string; downloadUrl?: string; data?: string };
}

export interface TestRun {
  id: number;
  name: string;
  state?: string;
  totalTests?: number;
  passedTests?: number;
  unanalyzedTests?: number;
  notApplicableTests?: number;
  incompleteTests?: number;
}

export interface TestResult {
  id: number;
  testCaseTitle?: string;
  automatedTestName?: string;
  outcome?: string;
  errorMessage?: string;
  stackTrace?: string;
  durationInMs?: number;
}

export interface Wiki {
  id: string;
  name: string;
  type?: string;
}

export interface WikiPage {
  path: string;
  order?: number;
  isParentPage?: boolean;
  subPages?: WikiPage[];
  content?: string;
}

/**
 * A task definition of `GET {org}/_apis/distributedtask/tasks`. The route is not in the public REST reference (it exists in
 * Microsoft's generated client), and the response was not verified against a real organization: treat every field as untrusted
 * and optional.
 */
export interface TaskDefinition {
  id?: string;
  name?: string;
  friendlyName?: string;
  description?: string;
  category?: string;
  helpMarkDown?: string;
  helpUrl?: string;
  contributionIdentifier?: string;
  deprecated?: boolean;
  preview?: boolean;
  version?: { major?: number; minor?: number; patch?: number; isTest?: boolean };
  groups?: { name?: string; displayName?: string; isExpanded?: boolean; visibleRule?: string }[];
  inputs?: {
    name?: string;
    label?: string;
    type?: string;
    required?: boolean;
    defaultValue?: string;
    helpMarkDown?: string;
    visibleRule?: string;
    groupName?: string;
    aliases?: string[];
    options?: Record<string, string>;
    properties?: Record<string, string>;
  }[];
}

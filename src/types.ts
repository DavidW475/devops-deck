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
  closedDate?: string;
  closedBy?: IdentityRef;
}

export interface PrIteration {
  id: number;
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
  attributes?: { name?: string };
}

export interface WorkItemUpdate {
  id: number;
  rev: number;
  revisedBy?: IdentityRef;
  fields?: Record<string, { oldValue?: unknown; newValue?: unknown }>;
}

export interface WorkItemComment {
  id: number;
  text: string;
  createdBy: IdentityRef;
  createdDate: string;
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
}

export interface TimelineRecord {
  id: string;
  parentId?: string | null;
  type: string;
  name: string;
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

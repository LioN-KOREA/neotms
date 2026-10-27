/**
 * 캐시 키.
 *
 * 한 파일에 모아 둔다. 키를 쓰는 곳에서 그때그때 배열 리터럴을 쓰면 무효화하는 쪽과 읽는 쪽의
 * 키가 어긋나고, 그 증상은 **오류가 아니라 낡은 화면**이다. 저장은 성공했는데 목록이 그대로라
 * 사용자가 한 번 더 저장을 누른다.
 *
 * 계층 구조를 지킨다: `['customers']` 를 무효화하면 그 아래 목록·상세가 모두 무효화된다.
 * react-query 는 키 배열의 접두사로 매칭하므로, 이 규칙만 지키면 "고객사를 수정했으니 고객사와
 * 관련된 것을 다시 읽어라"가 한 줄이 된다.
 */

export const neotmsKeys = {
  profile: ['profile'] as const,

  customers: ['customers'] as const,
  customerList: (query: unknown) => ['customers', 'list', query] as const,
  customer: (id: string) => ['customers', 'detail', id] as const,

  translators: ['translators'] as const,
  translatorList: (query: unknown) => ['translators', 'list', query] as const,
  translator: (id: string) => ['translators', 'detail', id] as const,

  projects: ['projects'] as const,
  projectList: (query: unknown) => ['projects', 'list', query] as const,
  project: (id: string) => ['projects', 'detail', id] as const,

  jobs: ['jobs'] as const,
  jobList: (query: unknown) => ['jobs', 'list', query] as const,
  job: (id: string) => ['jobs', 'detail', id] as const,

  purchaseOrders: ['purchase-orders'] as const,
  purchaseOrderList: (query: unknown) => ['purchase-orders', 'list', query] as const,
  purchaseOrder: (id: string) => ['purchase-orders', 'detail', id] as const,

  reports: ['reports'] as const,
  reportSummary: (query: unknown) => ['reports', 'summary', query] as const,
  workload: (range: unknown) => ['reports', 'workload', range] as const,
} as const

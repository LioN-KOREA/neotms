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

  /*
   * 코드. 두 목록이 같은 접두사 아래 있는 것이 중요하다.
   *
   * 유지보수 화면에서 코드를 하나 고치면 그 화면의 목록(`codesAdmin`)만이 아니라 모든 폼이 쓰는
   * 드롭다운 목록(`codesActive`)도 같이 낡는다. 접두사 하나를 무효화하면 둘 다 처리된다 —
   * 반대로 둘을 따로 두면, 코드명을 고친 담당자에게는 바로 반영되고 옆자리 PM 의 드롭다운에는
   * 옛 이름이 남는다.
   */
  codes: ['codes'] as const,
  codesActive: ['codes', 'active'] as const,
  codesAdmin: ['codes', 'admin'] as const,

  /*
   * 직원과 역할. 역할 목록은 직원 목록 아래가 아니라 따로다 — `sys_role` 은 직원을 고쳐도
   * 변하지 않으므로, 역할 배정 한 번에 역할 목록까지 다시 읽을 이유가 없다.
   */
  staff: ['staff'] as const,
  roles: ['roles'] as const,

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

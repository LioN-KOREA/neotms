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
   * 환율. `codes` 접두사 아래가 아니라 따로 둔다.
   *
   * 두 목록은 읽는 쪽도 권한도 같지만, **이 앱에는 환율을 쓰는 화면이 없다** — 넣는 것은 5분마다
   * 도는 수집기 람다다. 그래서 무효화할 쓰기가 없고, 접두사를 공유하면 코드를 하나 고칠 때마다
   * 환율까지 끌려와 다시 읽힌다. 수명도 다르다(neotms.query.ts 의 `useFxRates`).
   */
  fxRates: ['fx-rates'] as const,

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

  /*
   * 인보이스. `purchase-orders` 아래가 아니라 따로다.
   *
   * 둘이 서로를 무효화해야 하는 것은 맞지만, 그 방향은 **양쪽 모두**다 — 인보이스를 발행하면
   * 발주의 `invoiceTranslatorId` 가 바뀌고, 발주를 정산하면 그 발주가 달린 인보이스 행의
   * `poSum`·`poCount` 가 바뀐다. 한쪽을 다른 쪽의 접두사 아래 넣으면 한 방향만 공짜가 되고
   * 반대 방향은 여전히 손으로 적어야 하므로, 둘을 나란히 두고 양쪽에서 서로를 적는다
   * (neotms.mutation.ts 의 `PAYMENT_AFFECTS`).
   */
  invoices: ['invoices'] as const,
  invoiceList: (query: unknown) => ['invoices', 'list', query] as const,
  invoice: (id: string) => ['invoices', 'detail', id] as const,

  reports: ['reports'] as const,
  reportSummary: (query: unknown) => ['reports', 'summary', query] as const,
  workload: (range: unknown) => ['reports', 'workload', range] as const,

  /*
   * 대시보드. `reports` 아래가 아니라 따로 둔다.
   *
   * 접두사를 공유하면 리포트 하나를 무효화할 때 대시보드까지 끌려오고, 그 반대도 마찬가지다.
   * 둘은 같은 숫자를 다른 범위로 보는 화면이지만 **읽는 시점이 전혀 다르다** — 리포트는 '조회'
   * 버튼을 눌러야 읽고(`enabled`), 대시보드는 화면을 열면 바로 읽는다. 한 접두사에 묶으면
   * 대시보드를 여는 것만으로 리포트 캐시가 함께 낡는다.
   *
   * 역할(`sales`/`pm`)이 키에 들어간다. 한 사람이 어떤 프로젝트에서는 영업담당이고 다른
   * 프로젝트에서는 PM 인 경우가 정상이므로 두 응답은 서로 다른 숫자이고, 키를 공유하면 탭을
   * 옮길 때 옆 역할의 숫자가 잠깐 그려진다.
   */
  dashboards: ['dashboard'] as const,
  dashboard: (role: string) => ['dashboard', role] as const,
} as const

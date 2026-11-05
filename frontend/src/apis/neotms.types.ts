/**
 * API 가 주고받는 형태.
 *
 * ## 백엔드 타입의 사본이다
 *
 * lambdas/neotms/nodejs/neotms/*&#47;*.dbops.ts 의 `*Row` 타입과 필드가 1:1로 대응한다. 공유
 * 패키지로 묶지 않은 이유는 빌드 구조다 — Lambda 는 CommonJS tsconfig 로, 콘솔은 bundler
 * moduleResolution 으로 컴파일되고, 둘을 하나의 프로젝트 참조로 묶으면 둘 중 하나는 자기
 * 설정이 아닌 설정으로 빌드된다. MVP 단계에서 그 복잡도를 지불할 이유가 없다.
 *
 * 대신 **사본이라는 사실을 아는 상태로** 둔다. 필드가 어긋나면 `tsc` 는 아무 말도 하지 않고
 * (서버가 보내는 JSON 은 런타임 값이다) 화면에 `undefined` 가 뜬다. 필드를 추가할 때는 양쪽을
 * 같이 고쳐야 한다.
 *
 * ## 금액과 물량은 모두 string 이다
 *
 * `number` 가 아닌 것은 타이포가 아니다. PostgreSQL 의 `numeric` 을 JS number 로 받으면 2^53
 * 이상에서 정밀도가 사라지고, 0.1+0.2 가 0.30000000000000004 가 된다. 돈을 다루는 컬럼은
 * 전부 10진 문자열로 오고, 계산은 서버가 한다(shared/utils/money.ts 주석 참고).
 */

/* -------------------------------------------------------------------------- */
/* 공통                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 목록 응답. `total` 이 없는 것은 누락이 아니다.
 *
 * 키셋 페이지네이션을 쓰므로 전체 건수를 세려면 매 페이지마다 `COUNT(*)` 를 한 번 더 돌려야
 * 한다. 수십만 행에서 그 쿼리가 목록 쿼리보다 비싸고, DB 가 용량 고정인 소형 인스턴스이므로
 * 그 비용이 그대로 응답 시간이 된다. 화면은 "1/37 페이지" 대신 '더 보기' 를 쓴다.
 */
export interface ListPage<T> {
  items: T[]
  /** 다음 페이지 커서. 없으면 마지막 페이지다. */
  cursor?: string
}

/** 목록 공통 질의 파라미터. */
export interface ListQuery {
  limit?: number
  cursor?: string | null
  /** 정렬 키. 엔티티마다 허용 목록이 다르다(서버의 *_SORTS). */
  sort?: string
  dir?: 'asc' | 'desc'
  /** 검색어. 서버가 PGroonga 색인으로 부분일치 검색한다 — 두 글자 한국어도 걸린다. */
  q?: string
}

/* -------------------------------------------------------------------------- */
/* 내 정보 / 권한                                                              */
/* -------------------------------------------------------------------------- */

/** 메뉴에 대해 할 수 있는 다섯 가지. 서버의 MenuAction 과 같다. */
export type MenuAction = 'read' | 'create' | 'update' | 'delete' | 'export'

export interface MenuGrant {
  menuId: string
  name: string
  parent: string | null
  depth: number
  url: string | null
  ordNo: number | null
  /** 다섯 가지 동작 각각의 허용 여부. 권한이 하나도 없는 메뉴도 전부 false 로 들어온다. */
  may: Record<MenuAction, boolean>
}

/**
 * 이 계정이 NEOTMS 안에서 어디까지 와 있는지. 화면이 셋으로 갈린다.
 *
 *   * `unregistered` — LPX 계정은 확인됐지만 `staff` 행이 없다. 회원가입 폼을 보여준다.
 *   * `pending`      — `staff` 행은 있고 역할이 아직 없다. 승인 대기 안내를 보여준다.
 *   * `active`       — 역할이 배정됐다. 애플리케이션을 보여준다.
 *
 * 비활성 계정(`active = false`)은 여기 없다. 서버가 403 으로 거절하므로 이 타입에 담길 일이
 * 없고, 담겨서도 안 된다 — 관리자가 끈 계정에 회원가입 폼을 주면 새 `mgr_id` 로 다시 들어올 수
 * 있다.
 */
export type RegistrationStatus = 'unregistered' | 'pending' | 'active'

/**
 * 회원가입 폼의 초기값. LPX `/userInfo` 에서 그대로 온다.
 *
 * 세 상태 모두에서 내려온다. 대기 화면에서도 폼으로 돌아갈 수 있어야 하기 때문이다 — 기다리는
 * 동안 사람이 고치는 것은 대개 자기 이름이다.
 *
 * null 이 아니라 빈 문자열인 이유: 이 값들은 곧바로 `<input value={...}>` 에 들어가고,
 * `value={null}` 은 React 의 입력을 제어 불가 상태로 만든다.
 */
export interface ProfilePrefill {
  name: string
  email: string
}

/**
 * `/api/v0/me`. 로그인 후 한 번 읽고, 화면 구성 전체의 기준이 된다.
 *
 * 메뉴를 숨기는 것은 편의일 뿐 보안 장치가 아니다. 모든 API 는 서버에서 같은 권한을 다시
 * 확인한다(NeotmsAuthGuard). 숨겨진 메뉴의 URL 을 직접 입력해도 403 이 온다.
 *
 * ## `registration` 이 판별자이고, `staff` 행에서 읽는 값은 전부 선택적이다
 *
 * 아직 등록되지 않은 계정에는 `staffId` 도 `mgrId` 도 **없다**. `''` 같은 가짜 값을 채워
 * 보내지 않는 쪽을 택했다 — `staffId: ''` 는 id 처럼 보이는 id 아닌 값이고, 그게
 * `created_by` 비교로 흘러 들어가면 "아무것도 내 것이 아니다" 로 조용히 틀린다. 없으면 쓰는
 * 쪽이 없음을 처리하게 된다.
 *
 * `menus` 만은 예외로 항상 있다. 등록 전에는 `[]` 다. 역할이 없으니 권한도 없다는 정직한
 * 답이고, 필드가 항상 있으면 `mayDo` 같은 권한 헬퍼에 예외 분기를 둘 필요가 없다 — 빈 배열에
 * 대해 자연히 닫힌다.
 */
export interface ProfileView {
  registration: RegistrationStatus
  prefill: ProfilePrefill
  /** OIDC subject. 등록 전에도 아는 유일한 식별자. */
  sub: string
  staffId?: string
  /** 레거시 `MGR_ID`. 동료와 옛 문서가 쓰는 식별자라서 화면에 보여준다. */
  mgrId?: string
  name?: string
  email?: string
  corpCode?: string | null
  roleCode?: string | null
  roleName?: string | null
  /**
   * 모든 행을 볼 수 있는지. false 면 서버가 쿼리에 범위 조건을 붙인다.
   *
   * 화면에서 이 값으로 행을 걸러내지 않는다 — 걸러낼 행이 애초에 오지 않는다. 이 값은
   * "이 목록이 전체인가, 내 담당분인가" 를 **설명하기 위해서만** 쓴다. 그 설명이 없으면
   * 담당자는 자기가 보는 숫자가 회사 전체 숫자라고 착각한다.
   */
  seesEveryRow?: boolean
  menus: MenuGrant[]
}

/**
 * `POST /api/v0/registration` 의 본문. 서버의 `SelfProfileSchema` 와 같다.
 *
 * 여기 **없는** 것이 중요하다: `roleId`, `viewScope`, `active`, `mgrId`, `corpCode`, `lpxSub`.
 * 앞의 셋은 권한 체계이고 뒤의 셋은 신원이다. 여섯 중 하나라도 보낼 수 있는 폼이면, 쿠키를
 * 고쳐 역할을 바꿀 수 있었던 레거시의 구멍을 예의만 갖춰 다시 만드는 셈이 된다.
 *
 * 이름이 필수인 이유는 서버 주석과 같다 — `mgr_name` 은 발주서와 청구서에 찍히는 담당자이고,
 * 비어 있으면 쓸 수 없는 문서가 된다.
 */
export interface SelfProfileInput {
  name: string
  nameEng?: string | null
  email?: string | null
  phone?: string | null
  position?: string | null
}

/* -------------------------------------------------------------------------- */
/* 코드 (sys_code)                                                             */
/* -------------------------------------------------------------------------- */

/**
 * `sys_code` 한 행. 분야·작업 종류·단가 단위·언어·사용 프로그램이 모두 이 테이블에 있다.
 *
 * 스키마 전체에서 22개 컬럼이 `sys_code (code)` 를 `ON DELETE RESTRICT` 로 참조한다. 그래서
 * **`code` 는 바꿀 수 없다** — 수정 화면은 이름(`codeName`)만 고치고, 잘못 만든 코드는
 * 비활성화하고 새로 만든다. 자세한 이유는 NeotmsCode.dbops.ts 의 파일 주석에 있다.
 */
export interface CodeRow {
  id: string
  /** FK 대상값. 실제로 업무 테이블에 저장되는 문자열이고, 생성 후 변경 불가다. */
  code: string
  codeName: string | null
  codeEngName: string | null
  /** 상위 도메인의 `code`. null 이면 이 행 자체가 도메인이다. */
  codeParent: string | null
  ordNo: number | null
  active: boolean
}

/** `GET /api/v0/codes` 와 `GET /api/v0/admin/codes` 의 응답. 커서가 없다 — 전체를 한 번에 준다. */
export interface CodeListView {
  items: CodeRow[]
}

export interface CodeInput {
  code: string
  codeName?: string | null
  codeEngName?: string | null
  codeParent?: string | null
  ordNo?: number | null
  active?: boolean
}

/** 수정 입력. `code` 가 없는 것이 핵심이다 — 위 `CodeRow.code` 주석 참고. */
export type CodeUpdateInput = Partial<Omit<CodeInput, 'code'>>

/* -------------------------------------------------------------------------- */
/* 환율 (fx_rate_latest)                                                       */
/* -------------------------------------------------------------------------- */

/**
 * 통화 하나의 최신 고시 환율. `sys_code` 와 함께 `anyStaff` 로 열려 있는 둘뿐인 읽기다.
 *
 * ## 화면이 환율을 직접 받는 이유
 *
 * **리포트에 집계되는 금액은 전부 서버가 SQL 에서 환산한다**(`fx_rate_latest` 조인). 그런데도
 * 클라이언트가 환율을 받는 이유는 버튼 하나 때문이다 — '원화로 환산' 은 서버에 "이게 얼마냐" 를
 * 묻는 것이 아니라 **행을 다시 쓴다**(`coinCode` → KRW, 합계 → 환산액, `coinRate` → 1). 사용자가
 * 그 숫자를 **확정하기 전에 봐야** 하고, 폼은 금액을 입력하는 동안 원화 환산 합계를 실시간으로
 * 미리 보여준다. 둘 다 저장된 행에 대한 질의로는 답할 수 없는 값이다.
 */
export interface FxRateRow {
  /** ISO 4217 세 글자. `JobRow.coinCode` 와 정확히 같은 값이다. */
  currencyCode: string
  /**
   * 1 단위당 원화. 10진 문자열.
   *
   * `number` 가 아닌 이유는 이 파일 머리말과 같다 — 게다가 환율은 시스템에서 유일하게 **합계에
   * 곱해지는** 값이라, 정밀도 손실이 금액에 그대로 증폭된다. 쓰는 곳에서 파싱한다.
   *
   * JPY 도 1엔당 값이다. 고시 원문은 100엔당이지만 수집기가 나누어 넣으므로, 어떤 통화가 100
   * 단위로 고시되는지를 화면이 알 필요가 없다.
   */
  rate: string
  /**
   * 이 고시가 적용되는 영업일(KST).
   *
   * **화면에 반드시 같이 보여준다.** 뷰는 의도적으로 기간 제한이 없어서(db/014_fx_rates.sql),
   * 수집기가 조용히 죽으면 "환율 없음" 이 아니라 **오래된 환율**이 나온다. 그것이 안전한 유일한
   * 이유가 날짜가 금액 옆에 보인다는 점이다.
   */
  effectiveDate: string | null
  /** `'koreaexim'`, 또는 운영자가 직접 넣은 행이면 `'manual'`. */
  source: string | null
}

/**
 * `GET /api/v0/fx-rates` 의 응답. 커서가 없다 — 통화는 많아도 다섯 개다.
 *
 * **빈 배열은 오류가 아니라 정상 응답이다.** 수집기가 한 번도 성공하지 못했으면 비어 있고,
 * 수집 대상이 아닌 통화는 영구히 없다. 두 경우 모두 화면의 올바른 반응은 에러를 띄우는 것이
 * 아니라 **그 통화의 환산 버튼을 비활성화**하는 것이다 — 사용자는 원래 통화로 금액을 기록할 수
 * 있고, 열린 포지션 모델이 정확히 그것을 위해 있다.
 */
export interface FxRateListView {
  items: FxRateRow[]
}

/* -------------------------------------------------------------------------- */
/* 직원·역할 (staff, sys_role) — 사용자 관리                                    */
/* -------------------------------------------------------------------------- */

/**
 * `staff` 한 행, 관리자 화면용.
 *
 * `roleId` 와 `viewScope` 두 칸이 이 앱의 모든 권한을 결정한다 — `roleId` 는 `sys_role_auth` 를
 * 거쳐 메뉴 x 동작 행렬이 되고, `viewScope` 는 "내 행만" 과 "전부" 를 가른다. 그래서 이 두 칸을
 * 쓰는 화면은 하나뿐이고, 서버에도 쓰는 문장이 하나뿐이다(NeotmsStaffAdmin.dbops.ts).
 */
export interface StaffRow {
  id: string
  /** 레거시 `MGR_ID`. 이 사람이 만든 모든 행의 `created_by` 에 남아 있어서 바꿀 수 없다. */
  mgrId: string
  name: string | null
  nameEng: string | null
  email: string | null
  phone: string | null
  position: string | null
  /** null 이면 역할 미배정 — 가입 요청 상태다. 로그인은 되지만 아무것도 할 수 없다. */
  roleId: string | null
  roleCode: string | null
  roleName: string | null
  viewScope: string | null
  active: boolean
  /**
   * LPX 신원이 붙어 있는지.
   *
   * `lpx_sub` 자체는 서버가 **내려주지 않는다**(다른 사람 계정의 식별 토큰이고, 화면에 쓸 일이
   * 없다). 화면에 필요한 것은 이 불린뿐이다 — false 면 ETL 로 들어왔고 아직 아무도 그 계정으로
   * 로그인하지 않은 행이라는 뜻이고, 그래서 역할은 있는데 연락처가 비어 있을 수 있다.
   */
  linked: boolean
  createdAt: string | null
}

export interface StaffListView {
  items: StaffRow[]
}

/** 배정할 수 있는 역할. `sys_role.active = true` 인 것만 내려온다. */
export interface RoleOption {
  id: string
  roleCode: string
  roleName: string | null
}

export interface RoleListView {
  items: RoleOption[]
}

/**
 * 관리자가 쓸 수 있는 세 칸. **이 타입이 곧 권한 경계다.**
 *
 * 이름·메일·전화·직급이 없는 것은 의도다 — 그건 본인이 자기 프로필에서 관리하고, 역할을
 * 배정하는 관리자가 남의 전화번호를 고칠 이유는 없다. `mgrId`·`lpxSub` 가 없는 것은 그게
 * 신원이기 때문이다.
 *
 * `roleId: null` 은 "역할 회수" 이고, 키를 생략하는 것과 다르다 — 생략은 "건드리지 않음" 이다.
 */
export interface StaffUpdateInput {
  roleId?: string | null
  viewScope?: 'Y' | 'N'
  active?: boolean
}

/* -------------------------------------------------------------------------- */
/* 고객사                                                                      */
/* -------------------------------------------------------------------------- */

export interface CustomerRow {
  id: string
  cusCode: string
  cusName: string | null
  cusEmail: string | null
  cusPhone: string | null
  cusZip: string | null
  cusAddr: string | null
  cusNation: string | null
  /** 기본 통화. */
  cusCoin: string | null
  /**
   * 사용 프로그램(UPRO) — **등급이 아니다.** 이 주석은 한때 "등급/단가 밴드"라고 적혀 있었고,
   * 그것은 틀린 설명이었다. 고객사가 주로 쓰는 번역 프로그램(Trados 등)을 가리키는
   * `sys_code` 'UPRO' 도메인의 코드값이다.
   *
   * **읽기 전용이다.** 모든 고객사가 번역을 발주하는 것은 아니므로 등록 화면에서 묻지 않고,
   * `CustomerInput` 에도 없다. 그래도 타입에 남겨 두는 이유는 ETL 이 레거시 `CUS_UPRO` 를
   * 이 컬럼에 적재하고, 그 값이 화면에서 보이지 않는 것과 타입에서 사라지는 것은 다르기 때문이다.
   * 번역가의 `TranslatorRow.tranUpro` 는 계속 입력받는다 — 배포 대상을 고르는 데 필요하다.
   */
  cusUpro: string | null
  /** 최소 수주 금액. 10진 문자열(`numeric(18,2)`), 통화는 `cusCoin`. */
  cusMincost: string | null
  /** 주요 분야. `sys_code` 참조 코드값. */
  cusField: string | null
  active: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface CustomerInput {
  /** 유일한 필수 항목. 코드(`cusCode`)는 서버가 시퀀스로 발급한다. */
  cusName: string
  cusEmail?: string | null
  cusPhone?: string | null
  cusZip?: string | null
  cusAddr?: string | null
  cusNation?: string | null
  cusCoin?: string | null
  // cusUpro 는 여기에 없다. 서버의 CUSTOMER_FIELDS 에서도 빠졌으므로 보내도 조용히 버려진다.
  // 폼에서 묻지 않는 값을 입력 타입에 남겨 두면, 빈 문자열로 저장을 덮어쓰는 코드가 다시 생긴다.
  cusMincost?: string | null
  /** 주요 분야. `sys_code` 'FIELD' 도메인의 코드값 — 드롭다운에서 고른다. */
  cusField?: string | null
  active?: boolean | null
}

/* -------------------------------------------------------------------------- */
/* 번역가                                                                      */
/* -------------------------------------------------------------------------- */

export interface TranslatorRow {
  id: string
  tranCode: string
  tranName: string | null
  tranPhone: string | null
  tranEmail: string | null
  /** 중복 등록 메모. 레거시 컬럼을 그대로 유지한다. */
  tranDup: string | null
  tranMsg: string | null
  tranWorkCon: string | null
  /** CAT 툴 사용 여부. */
  tranCatUse: boolean
  tranCalc: string | null
  /**
   * 사용 프로그램(UPRO). `sys_code` 'UPRO' 도메인의 코드값 — 등급이 아니다.
   *
   * 고객사의 `cusUpro` 와 달리 이 값은 계속 입력받는다. Trados 패키지를 Trados 를 쓰지 않는
   * 번역가에게 보내면 그대로 되돌아오므로, 배포 대상을 고를 때 실제로 쓰이는 값이다.
   */
  tranUpro: string | null
  /** 가능 분야. `sys_code` 참조 코드값. */
  tranField: string | null
  /** 불가 분야. `sys_code` 참조 코드값. */
  tranUnfield: string | null
  tranCoin: string | null
  tranGive: string | null
  /**
   * 원천징수(ICTAX). 세율(`3.3`)인지 구분 코드인지 **아직 확인되지 않았다.** 그래서 서버도
   * `text` 로 두었다(db/002_tables.sql 의 COMMENT). 숫자로 다루면 안 된다.
   */
  tranIctax: string | null
  tranBank: string | null
  tranAcc: string | null
  tranPaypal: string | null
  tranRegDay: string | null
  active: boolean
  createdAt: string | null
  updatedAt: string | null
}

export interface TranslatorInput {
  tranName: string
  tranPhone?: string | null
  tranEmail?: string | null
  tranDup?: string | null
  tranMsg?: string | null
  tranWorkCon?: string | null
  tranCatUse?: boolean | null
  tranCalc?: string | null
  tranUpro?: string | null
  tranField?: string | null
  tranUnfield?: string | null
  tranCoin?: string | null
  tranGive?: string | null
  tranIctax?: string | null
  tranBank?: string | null
  tranAcc?: string | null
  tranPaypal?: string | null
  tranRegDay?: string | null
  active?: boolean | null
}

/* -------------------------------------------------------------------------- */
/* 프로젝트                                                                    */
/* -------------------------------------------------------------------------- */

export interface ProjectRow {
  id: string
  prjCode: string
  prjName: string | null
  corpId: string | null
  coinCode: string | null
  /** 영업담당자. */
  prjMgrId: string | null
  prjMgrName: string | null
  /** PM. */
  prjPmId: string | null
  prjPmName: string | null
  customerId: string | null
  cusCodeName: string | null
  customerContactId: string | null
  cusMgrName: string | null
  prjField: string | null
  prjField2: string | null
  prjState: string | null
  prjInvoiceState: string | null
  prjMoneyState: string | null
  invCode: string | null
  invDt: string | null
  prjSday: string | null
  prjSdayTime: string | null
  prjEday: string | null
  prjEdayTime: string | null
  prjContent: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface ProjectInput {
  prjName: string
  /** 필수. 고객사 없는 프로젝트는 매출 귀속이 불가능하다. */
  customerId: string
  corpId?: string | null
  coinCode?: string | null
  prjMgrId?: string | null
  prjPmId?: string | null
  customerContactId?: string | null
  prjField?: string | null
  prjField2?: string | null
  prjState?: string | null
  prjInvoiceState?: string | null
  prjMoneyState?: string | null
  invCode?: string | null
  invDt?: string | null
  prjSday?: string | null
  prjSdayTime?: string | null
  prjEday?: string | null
  prjEdayTime?: string | null
  prjContent?: string | null
}

/* -------------------------------------------------------------------------- */
/* 작업(JOB) — 매출                                                            */
/* -------------------------------------------------------------------------- */

export interface JobRow {
  id: string
  jobCode: string
  projectId: string
  prjCode: string | null
  prjName: string | null
  cusCodeName: string | null
  jobName: string | null
  workCode: string | null
  jobPmId: string | null
  jobPmName: string | null
  /**
   * 업무 구분. `JOBTYPE` 코드이고, 이 작업이 언어쌍을 가지는지 업무 분류를 가지는지 결정한다.
   *
   * 서버에서 NOT NULL 이라 `null` 로 오지 않지만, 타입은 다른 코드 필드와 같은 모양으로 둔다 —
   * 이 값만 `string` 으로 두면 `CodeSelect` 와 필터 처리에서 혼자 예외가 된다.
   */
  jobType: string | null
  /** 출발어. 'LINGUISTICS' 작업에만 있다(서버의 `job_detail_linguistic`). */
  jobSlang: string | null
  /** 도착어. 출발어와 같은 조건이다. */
  jobElang: string | null
  /** 업무 분류. `JOBCAT` 코드. MICE·IMC 작업에만 있다(`job_detail_non_linguistic`). */
  jobCategory: string | null
  /** 물량. 10진 문자열. */
  jobVolume: string | null
  unitCode: string | null
  jobPriceSel: string | null
  /** 단가. 10진 문자열. */
  jobPrice: string | null
  /** 할인. 10진 문자열. */
  jobPriceDis: string | null
  coinCode: string | null
  /**
   * **환전된 환율. 환전하지 않았으면 `null`.** 값이 붙은 정산 플래그로 읽는다.
   *
   * 외화 작업인데 이 값이 `null` 이면 아직 환전하지 않은 **열린 포지션**이고, 그 원화 가치는
   * 아래 `jobPriceKrw` 이며 매일 움직인다. `null` 이 아니면 **정산 완료**이고 `jobPriceKsum` 이
   * 그대로 고정된 금액이다. 콘솔의 '원화로 환산' 버튼이 `coinCode` 를 KRW 로 바꾸는 것과 동시에
   * 이 값을 1 로 쓴다 — 환전과 고정이 한 동작이다. db/014_fx_rates.sql 참고.
   */
  coinRate: string | null
  /** 외화 기준 합계. 10진 문자열. */
  jobPriceSum: string | null
  /** **장부상 원화 합계.** 폼이 편집하는 값이고, 발행된 계산서에 적힌 금액이다. */
  jobPriceKsum: string | null
  /**
   * **지금 시점의 원화 가치 = 이 작업의 매출.** 리포트의 revenue 가 이 값의 합이다.
   *
   * 정산된 작업에서는 `jobPriceKsum` 과 같다. 환전하지 않은 외화 작업에서만 다르고, 그때는
   * `jobPriceSum` × 오늘 환율이다 — 서버가 `fx_rate_latest` 를 조인해 **읽을 때마다** 계산하므로
   * 저장된 컬럼이 아니다.
   *
   * 등록·수정 응답(`RETURNING` 경로)에서는 `null` 이다. 목록과 상세 조회에는 항상 있다. 화면에
   * 금액을 보여줄 때는 이 값을, 폼에서 편집할 때는 `jobPriceKsum` 을 쓴다.
   */
  jobPriceKrw: string | null
  jobSday: string | null
  jobSdayTime: string | null
  jobEday: string | null
  jobEdayTime: string | null
  jobMemo: string | null
  jobState: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface JobInput {
  /** 필수. 작업은 프로젝트 없이 존재하지 않는다. */
  projectId: string
  jobName: string
  workCode?: string | null
  jobPmId?: string | null
  /** 업무 구분. 생략하면 서버가 'LINGUISTICS' 로 둔다(컬럼의 DEFAULT). */
  jobType?: string | null
  jobSlang?: string | null
  jobElang?: string | null
  /** 업무 분류. 언어쌍과 둘 중 하나만 보낸다 — 어긋나면 서버가 400 으로 거절한다. */
  jobCategory?: string | null
  jobVolume?: string | null
  unitCode?: string | null
  jobPriceSel?: string | null
  jobPrice?: string | null
  jobPriceDis?: string | null
  coinCode?: string | null
  coinRate?: string | null
  jobPriceSum?: string | null
  jobPriceKsum?: string | null
  jobSday?: string | null
  jobSdayTime?: string | null
  jobEday?: string | null
  jobEdayTime?: string | null
  jobMemo?: string | null
  jobState?: string | null
}

/** 수정에는 `projectId` 가 없다. 작업을 다른 프로젝트로 옮기는 것은 매출 이동이므로 막혀 있다. */
export type JobUpdate = Omit<JobInput, 'projectId'>

/* -------------------------------------------------------------------------- */
/* 발주(PO) — 원가                                                             */
/* -------------------------------------------------------------------------- */

export interface PurchaseOrderRow {
  id: string
  poCode: string
  jobId: string
  projectId: string
  jobCode: string | null
  jobName: string | null
  prjCode: string | null
  prjName: string | null
  poName: string | null
  poWorkCode: string | null
  /** CAT 분석 사용 여부. */
  poCatUse: boolean
  poCatWord: string | null
  poCatMid: string | null
  poCatStotal: string | null
  poPmId: string | null
  poPmName: string | null
  translatorId: string | null
  poTranName: string | null
  /**
   * 업무 구분. **작업의 업무 구분과 별개다** — MICE 행사에 통역 발주를 내는 것이 정상이다.
   *
   * `poLang`(인쇄용 발주서의 한/영 서식)과 `poCatWord` 등 `poCat*`(CAT 분석 수치)은 전혀 다른
   * 필드다. 이름이 비슷해서 자주 혼동된다.
   */
  poType: string | null
  poSlang: string | null
  poElang: string | null
  /** 업무 분류. `JOBCAT` 코드. MICE·IMC 발주에만 있다. */
  poCategory: string | null
  /** 물량. 10진 문자열. */
  poVolume: string | null
  poUnitCode: string | null
  poPriceSel: string | null
  /** 단가. 10진 문자열. */
  poPrice: string | null
  poCoinCode: string | null
  /** 환전된 환율. 환전하지 않았으면 `null`. `JobRow.coinRate` 와 의미가 완전히 같다. */
  poCoinRate: string | null
  poPriceSum: string | null
  /** **장부상 원화 합계.** 폼이 편집하는 값이다. */
  poPriceKsum: string | null
  /**
   * **지금 시점의 원화 가치 = 이 발주의 원가.** 리포트의 cost 가 이 값의 합이다.
   *
   * `JobRow.jobPriceKrw` 와 같은 규칙이다 — 정산된 발주에서는 `poPriceKsum` 과 같고, 환전하지
   * 않은 외화 발주에서만 `poPriceSum` × 오늘 환율이다. 등록·수정 응답에서는 `null`.
   */
  poPriceKrw: string | null
  poTax: string | null
  poTaxPrice: string | null
  poTaxSum: string | null
  poSday: string | null
  poSdayTime: string | null
  poEday: string | null
  poEdayTime: string | null
  poLang: string | null
  poContent: string | null
  poState: string | null
  poStateDt: string | null
  poInvoiceState: string | null
  poMoneyState: string | null
  poMoneyDay: string | null
  poMoneyPrice: string | null
  poMoneyGubun: string | null
  invCode: string | null
  invDt: string | null
  createdAt: string | null
  updatedAt: string | null
}

export interface PurchaseOrderInput {
  /** 필수. 발주는 작업에 달린다 — 그래서 원가가 매출에 대응된다. */
  jobId: string
  poName: string
  poWorkCode?: string | null
  poCatUse?: boolean | null
  poCatWord?: string | null
  poCatMid?: string | null
  poCatStotal?: string | null
  poPmId?: string | null
  translatorId?: string | null
  /** 업무 구분. 등록할 때 생략하면 서버가 **작업의 업무 구분**을 따른다. 그 뒤로는 따로 고친다. */
  poType?: string | null
  poSlang?: string | null
  poElang?: string | null
  /** 업무 분류. 언어쌍과 둘 중 하나만 보낸다. */
  poCategory?: string | null
  poVolume?: string | null
  poUnitCode?: string | null
  poPriceSel?: string | null
  poPrice?: string | null
  poCoinCode?: string | null
  poCoinRate?: string | null
  poPriceSum?: string | null
  poPriceKsum?: string | null
  poTax?: string | null
  poTaxPrice?: string | null
  poTaxSum?: string | null
  poSday?: string | null
  poSdayTime?: string | null
  poEday?: string | null
  poEdayTime?: string | null
  poLang?: string | null
  poContent?: string | null
  poState?: string | null
  poStateDt?: string | null
  poInvoiceState?: string | null
  poMoneyState?: string | null
  poMoneyDay?: string | null
  poMoneyPrice?: string | null
  poMoneyGubun?: string | null
  invCode?: string | null
  invDt?: string | null
}

/** 수정에는 `jobId` 가 없다. 발주를 다른 작업으로 옮기면 원가 귀속이 바뀐다. */
export type PurchaseOrderUpdate = Omit<PurchaseOrderInput, 'jobId'>

/* -------------------------------------------------------------------------- */
/* 리포트                                                                      */
/* -------------------------------------------------------------------------- */

export type ReportGroupBy =
  | 'date'
  | 'customer'
  | 'pm'
  | 'salesManager'
  | 'corp'
  | 'category'
  | 'langPair'
  | 'jobType'
  | 'jobCategory'

export interface ReportQuery {
  /** `YYYY-MM-DD`. 필수. */
  from: string
  to: string
  groupBy: ReportGroupBy
  customerId?: string | null
  pmId?: string | null
  salesManagerId?: string | null
  corpId?: string | null
  /**
   * 막대 그래프에 보여 줄 줄 수. 1~30(서버의 `REPORT_TOP_N_MAX`).
   *
   * 숫자가 아니라 **문자열**인 이유: 이 값은 `<select>` 의 `value` 에서 그대로 오고, 쿼리
   * 문자열로 나갈 때도 문자열이다. 중간에서 `Number()` 로 바꾸면 빈 값이 `0` 이 되고
   * (`Number('') === 0`), 0 은 서버 스키마가 거부하므로 "조회를 눌렀는데 400" 이 된다.
   * 서버의 `ReportTopNSchema` 가 문자열·숫자를 모두 받으니, 문자열로 흘려보내면 변환 지점이
   * 아예 없어서 이 함정이 생길 자리가 없다.
   *
   * 비어 있으면 서버 상한(1000줄)까지 돌려준다 — 화면은 항상 값을 보낸다.
   */
  limit?: string | null
}

/** 집계 한 줄. 세 값 모두 10진 문자열이다. margin = revenue - cost 를 서버가 계산한 값. */
export interface ReportLine {
  key: string
  label: string
  revenue: string
  cost: string
  margin: string
}

export interface ReportTotals {
  revenue: string
  cost: string
  margin: string
  /** 집계에 들어간 행 수. */
  rows: number
}

export interface ReportResult {
  query: ReportQuery
  totals: ReportTotals
  lines: ReportLine[]
  /**
   * 결과가 잘렸는지. 잘렸다면 합계는 **전체 합계가 아니다.**
   *
   * 이 값을 무시하면 화면이 부분 합계를 전체 합계처럼 보여 준다. 금액이 틀린 리포트는 없는
   * 리포트보다 나쁘다 — 그래서 화면은 이 값이 true 일 때 경고를 반드시 띄운다.
   */
  truncated: boolean
  /**
   * 이 응답을 만든 시각. **데이터의 기준 시점이 아니다.**
   *
   * 서버가 요청마다 원본 테이블을 집계하므로 "어디까지 반영된 데이터" 라는 개념이 없다 — 이
   * 값은 Lambda 가 응답을 조립한 순간이고, 숫자는 그 순간의 숫자다. 야간 집계표를 읽던 구조에
   * 서는 같은 필드가 "집계가 돌아간 시각" 을 뜻했고 그때는 반영 시점이었다. 이름이 그대로라서
   * 뜻도 그대로라고 읽기 쉬우니, 화면 라벨을 '집계 시각' 이 아니라 '조회 시각' 으로 두는 것
   * 까지가 이 필드의 계약이다 — ReportsView 의 해당 주석.
   */
  computedAt: string
}

/** 마감 임박 현황. 기본 기간은 오늘부터 7일. */
export interface WorkloadCounts {
  jobsDue: number
  posDue: number
  /** 발주가 아직 없는 작업 수. 원가가 비어 있으니 마진이 과대계상된 상태다. */
  jobsWithoutPo: number
}

/* -------------------------------------------------------------------------- */
/* 대시보드                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * '내 프로젝트' 의 정의. 이 값이 대시보드 두 개를 가르는 **유일한** 차이다.
 *
 * `sales` 는 `project.prj_mgr_id`(영업담당), `pm` 은 `project.prj_pm_id`(PM)를 나의 것으로 센다.
 * 한 사람이 어떤 프로젝트에서는 영업담당이고 다른 프로젝트에서는 PM 인 것이 정상이므로 두 숫자는
 * 서로 다르고, 어느 쪽을 보고 있는지는 화면 제목이 밝혀야 한다.
 */
export type DashboardRole = 'sales' | 'pm'

/** 대시보드 한 장. `GET /api/v0/dashboard/sales` 와 `GET /api/v0/dashboard/pm` 의 응답. */
export interface DashboardSummary {
  /**
   * 요청한 역할을 서버가 되돌려준 값.
   *
   * 캐시 두 개를 들고 있는 화면이 둘을 구별할 수 있게 하기 위한 것이다 — 탭을 옮긴 직후
   * 이전 역할의 응답이 잠깐 그려지는 일을 이 값으로 확인할 수 있다.
   */
  role: DashboardRole
  /** 삭제되지 않은 내 프로젝트 전부. 아래 세 타일을 읽는 분모다. */
  projects: number
  /** 진행. */
  inProgress: number
  /**
   * 납기일이 지났고 완료·취소가 아닌 것.
   *
   * **다른 두 타일과 겹친다.** 납기가 지난 진행 프로젝트는 진행이면서 동시에 지연이고, 납기가
   * 지난 보류 프로젝트는 보류이면서 동시에 지연이다. 셋은 같은 집합에 던지는 세 가지 질문이고
   * 집합의 분할이 아니므로 **합이 `projects` 와 같지 않다** — 화면이 그 사실을 적어 두어야
   * 한다. 그러지 않으면 담당자가 세 숫자를 더해 보고 데이터가 틀렸다고 판단한다.
   */
  overdue: number
  /** 보류. 레거시 화면의 'Holding 프로젝트' 타일. */
  onHold: number
  /**
   * 이 빌드가 모르는 `prj_state` 값을 가진 프로젝트 수.
   *
   * **0 이 아니면 위의 세 숫자를 믿을 수 없다.** `prj_state` 는 제약이 없는 자유 텍스트이고,
   * 운영 데이터의 어휘가 우리 목록과 다르면 타일은 오류 없이 0 을 가리킨다. 0 을 가리키는
   * 타일은 좋은 소식으로 읽히므로, 이 숫자가 옆에 있어야 '정말 없음' 과 '못 세었음' 이
   * 구별된다. 화면은 이 값이 0 보다 클 때 경고를 반드시 띄운다.
   */
  unrecognisedState: number
  /** 10진 문자열. 기간 제한 없는 **전체** 금액이다 — 화면 라벨이 그렇게 밝혀야 한다. */
  revenue: string
  cost: string
  margin: string
}

import {
  NEOTMS_PERMISSION_CUSTOMER_CREATE,
  NEOTMS_PERMISSION_CUSTOMER_DELETE,
  NEOTMS_PERMISSION_CUSTOMER_READ,
  NEOTMS_PERMISSION_CUSTOMER_UPDATE,
  NEOTMS_PERMISSION_DASHBOARD_PM_READ,
  NEOTMS_PERMISSION_DASHBOARD_SALES_READ,
  NEOTMS_PERMISSION_INVOICE_CREATE,
  NEOTMS_PERMISSION_INVOICE_DELETE,
  NEOTMS_PERMISSION_INVOICE_READ,
  NEOTMS_PERMISSION_INVOICE_UPDATE,
  NEOTMS_PERMISSION_JOB_CREATE,
  NEOTMS_PERMISSION_JOB_DELETE,
  NEOTMS_PERMISSION_JOB_READ,
  NEOTMS_PERMISSION_JOB_UPDATE,
  NEOTMS_PERMISSION_MAINTENANCE_CREATE,
  NEOTMS_PERMISSION_MAINTENANCE_DELETE,
  NEOTMS_PERMISSION_MAINTENANCE_READ,
  NEOTMS_PERMISSION_MAINTENANCE_UPDATE,
  NEOTMS_PERMISSION_PO_APPROVE,
  NEOTMS_PERMISSION_PO_CREATE,
  NEOTMS_PERMISSION_PO_DELETE,
  NEOTMS_PERMISSION_PO_EMAIL,
  NEOTMS_PERMISSION_PO_READ,
  NEOTMS_PERMISSION_PO_UPDATE,
  NEOTMS_PERMISSION_PROJECT_CREATE,
  NEOTMS_PERMISSION_PROJECT_DELETE,
  NEOTMS_PERMISSION_PROJECT_EMAIL,
  NEOTMS_PERMISSION_PROJECT_READ,
  NEOTMS_PERMISSION_PROJECT_UPDATE,
  NEOTMS_PERMISSION_REPORT_READ,
  NEOTMS_PERMISSION_STAFF_READ,
  NEOTMS_PERMISSION_STAFF_UPDATE,
  NEOTMS_PERMISSION_TRANSLATOR_CREATE,
  NEOTMS_PERMISSION_TRANSLATOR_DELETE,
  NEOTMS_PERMISSION_TRANSLATOR_READ,
  NEOTMS_PERMISSION_TRANSLATOR_UPDATE,
  NEOTMS_USER_ATTRIBUTE_PM,
  NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
  NEOTMS_USER_ATTRIBUTE_SUPERUSER,
} from '@/apis/neotms.authorities'

/**
 * Korean labels for the permission names, grouped the way the 역할 관리 screen lists them.
 *
 * ## Why this is a separate file from `neotms.authorities.ts`
 *
 * That file is a mirror of the server's vocabulary and is regenerated from it, so it holds names
 * and nothing else. These are UI strings for one screen. Keeping them apart means a label can be
 * reworded without touching the file whose job is to agree with the server character for character.
 *
 * ## Why every permission needs a sentence, not just a name
 *
 * The screen's reader is deciding what a job title may do, and `NEOTMS_PERMISSION_PO_APPROVE`
 * does not say that approving is separate from raising. A checkbox list of thirty-six constant
 * names is a list somebody ticks by shape - everything ending in READ, then everything ending in
 * UPDATE - and that is how a role ends up able to approve its own purchase orders.
 *
 * A test asserts these cover `NEOTMS_PERMISSIONS` exactly, so a permission added to the server
 * cannot appear on this screen as a bare constant, and one removed cannot linger as a tickable box
 * that no route consults.
 */
export interface PermissionLabel {
  name: string
  label: string
  /** One line on what holding it actually allows. Shown under the label. */
  hint: string
  /**
   * Set when ticking this box is a decision somebody should pause over, rather than one more
   * capability. The screen marks these; see `RolePermissionsModal`.
   */
  sensitive?: true
}

export interface PermissionGroup {
  id: string
  label: string
  /** What this group of permissions is about, in the screen's own terms. */
  hint: string
  permissions: readonly PermissionLabel[]
}

export const PERMISSION_GROUPS: readonly PermissionGroup[] = [
  {
    id: 'project',
    label: '프로젝트',
    hint: '고객에게서 받은 일 자체. 작업과 발주가 여기에 달린다.',
    permissions: [
      {
        name: NEOTMS_PERMISSION_PROJECT_READ,
        label: '조회',
        hint: '프로젝트 목록과 상세를 연다. 이 권한이 없으면 메뉴 자체가 사이드바에 나오지 않는다.',
      },
      { name: NEOTMS_PERMISSION_PROJECT_CREATE, label: '등록', hint: '새 프로젝트를 만든다.' },
      {
        name: NEOTMS_PERMISSION_PROJECT_UPDATE,
        label: '수정',
        hint: '거래처·기간·담당자·금액을 고친다.',
      },
      {
        name: NEOTMS_PERMISSION_PROJECT_DELETE,
        label: '삭제',
        hint: '프로젝트를 삭제 처리한다. 달린 작업과 발주도 함께 보이지 않게 된다.',
      },
      {
        name: NEOTMS_PERMISSION_PROJECT_EMAIL,
        label: '인계메일 발송',
        hint: '거래처·언어·마감일과 프로젝트 내용을, 보내는 사람이 입력한 주소로 메일로 내보낸다. 조회와 별개의 권한인 이유가 그것이다 — 화면에서 보는 것과 회사 밖으로 내보내는 것은 다른 결정이다.',
        sensitive: true,
      },
    ],
  },
  {
    id: 'job',
    label: '작업',
    hint: '프로젝트를 쪼갠 실제 작업 단위. 번역·통역·DTP 등.',
    permissions: [
      { name: NEOTMS_PERMISSION_JOB_READ, label: '조회', hint: '작업 목록과 상세를 연다.' },
      { name: NEOTMS_PERMISSION_JOB_CREATE, label: '등록', hint: '프로젝트에 작업을 추가한다.' },
      { name: NEOTMS_PERMISSION_JOB_UPDATE, label: '수정', hint: '작업의 내용·기간·금액을 고친다.' },
      { name: NEOTMS_PERMISSION_JOB_DELETE, label: '삭제', hint: '작업을 삭제 처리한다.' },
    ],
  },
  {
    id: 'po',
    label: '발주 (PO)',
    hint: '번역가에게 내보내는 일. 금액을 약속하는 문서다.',
    permissions: [
      { name: NEOTMS_PERMISSION_PO_READ, label: '조회', hint: '발주 목록과 상세, 발주서 출력본을 연다.' },
      { name: NEOTMS_PERMISSION_PO_CREATE, label: '등록', hint: '작업에 발주를 만든다. PM 의 일상 업무다.' },
      { name: NEOTMS_PERMISSION_PO_UPDATE, label: '수정', hint: '발주의 단가·수량·기간을 고친다. 금액을 바꾸는 권한이다.' },
      { name: NEOTMS_PERMISSION_PO_DELETE, label: '삭제', hint: '발주를 삭제 처리한다.' },
      {
        name: NEOTMS_PERMISSION_PO_APPROVE,
        label: '승인',
        hint: '발주 금액을 결재한다. 등록·수정과 일부러 분리된 권한이다 — 같은 권한으로 묶으면 발주를 만든 사람이 자기 발주를 스스로 승인할 수 있고, 그건 승인 절차가 아니라 형식이 된다. 승인되지 않은 발주는 출력도 발송도 되지 않는다.',
        sensitive: true,
      },
      {
        name: NEOTMS_PERMISSION_PO_EMAIL,
        label: '발주서 발송',
        hint: '아직 기능이 없다. 번역가에게 발주서를 메일로 보내는 화면이 생기면 이 권한이 그 문을 지킨다 — 지금 켜 두면 아무 일도 일어나지 않고, 나중에 화면이 생기는 날 아무도 의도하지 않은 권한이 켜져 있게 된다.',
      },
    ],
  },
  {
    id: 'translator',
    label: '번역가',
    hint: '번역가 명부. 단가와 연락처를 포함한다.',
    permissions: [
      { name: NEOTMS_PERMISSION_TRANSLATOR_READ, label: '조회', hint: '번역가 명부와 단가를 연다.' },
      { name: NEOTMS_PERMISSION_TRANSLATOR_CREATE, label: '등록', hint: '번역가를 등록한다.' },
      { name: NEOTMS_PERMISSION_TRANSLATOR_UPDATE, label: '수정', hint: '연락처·계좌·단가를 고친다.' },
      { name: NEOTMS_PERMISSION_TRANSLATOR_DELETE, label: '삭제', hint: '번역가를 삭제 처리한다.' },
    ],
  },
  {
    id: 'invoice',
    label: '결제',
    hint: '번역가 인보이스와 입금 확인. 돈이 실제로 움직인 사실을 적는 곳이다.',
    permissions: [
      {
        name: NEOTMS_PERMISSION_INVOICE_READ,
        label: '조회',
        hint: 'PO 승인·정산 화면과 번역가 인보이스 화면을 연다.',
      },
      { name: NEOTMS_PERMISSION_INVOICE_CREATE, label: '인보이스 발행', hint: '번역가 인보이스를 만든다.' },
      {
        name: NEOTMS_PERMISSION_INVOICE_UPDATE,
        label: '정산 입력',
        hint: '입금 사실과 금액을 적는다. 발주 승인과는 다른 권한이다 — 금액을 결재하는 일과 돈이 나간 것을 확인하는 일은 보통 다른 사람이 한다.',
      },
      { name: NEOTMS_PERMISSION_INVOICE_DELETE, label: '인보이스 취소', hint: '발행한 인보이스를 취소한다.' },
    ],
  },
  {
    id: 'customer',
    label: '고객사',
    hint: '거래처와 그 담당자.',
    permissions: [
      { name: NEOTMS_PERMISSION_CUSTOMER_READ, label: '조회', hint: '거래처 목록과 담당자를 연다.' },
      { name: NEOTMS_PERMISSION_CUSTOMER_CREATE, label: '등록', hint: '거래처를 등록한다.' },
      { name: NEOTMS_PERMISSION_CUSTOMER_UPDATE, label: '수정', hint: '거래처 정보와 담당자를 고친다.' },
      { name: NEOTMS_PERMISSION_CUSTOMER_DELETE, label: '삭제', hint: '거래처를 삭제 처리한다.' },
    ],
  },
  {
    id: 'insight',
    label: '리포트와 대시보드',
    hint: '집계 화면. 대시보드는 사람별로 따로 부여한다.',
    permissions: [
      {
        name: NEOTMS_PERMISSION_REPORT_READ,
        label: '리포트 조회',
        hint: '기간별·고객사별·담당자별 매출과 마진 집계를 연다. 열람 범위가 회사 전체인 사람에게는 다른 사람의 실적까지 보인다.',
        sensitive: true,
      },
      {
        name: NEOTMS_PERMISSION_DASHBOARD_SALES_READ,
        label: '대시보드(영업)',
        hint: '영업 담당자용 요약 화면. 보통 담당영업에게만 준다.',
      },
      {
        name: NEOTMS_PERMISSION_DASHBOARD_PM_READ,
        label: '대시보드(PM)',
        hint: 'PM 용 요약 화면. 두 대시보드를 따로 둔 이유는, 하나로 묶으면 PM 에게 영업 화면까지 열리고 주지 않으면 PM 화면도 사라지기 때문이다. 시스템 담당자는 둘 다 갖는다.',
      },
    ],
  },
  {
    id: 'maintenance',
    label: '각종 코드 및 변수 관리',
    hint: '분야·언어·작업 종류 같은 선택지 목록. 모든 폼의 드롭다운이 여기서 나온다.',
    permissions: [
      { name: NEOTMS_PERMISSION_MAINTENANCE_READ, label: '조회', hint: '폐기된 코드까지 포함한 전체 목록을 연다.' },
      { name: NEOTMS_PERMISSION_MAINTENANCE_CREATE, label: '등록', hint: '새 코드를 추가한다.' },
      {
        name: NEOTMS_PERMISSION_MAINTENANCE_UPDATE,
        label: '수정',
        hint: '코드의 이름·순서·사용 여부를 고친다. 코드값 자체는 누구도 바꿀 수 없다.',
      },
      { name: NEOTMS_PERMISSION_MAINTENANCE_DELETE, label: '삭제', hint: '아무도 쓰지 않는 코드를 지운다.' },
    ],
  },
  {
    id: 'staff',
    label: '사용자 관리',
    hint: '직원 명부와 역할 배정. 이 두 칸이 다른 모든 권한의 출처다.',
    permissions: [
      {
        name: NEOTMS_PERMISSION_STAFF_READ,
        label: '조회',
        hint: '직원 목록과 각자의 역할·열람 범위를 연다.',
      },
      {
        name: NEOTMS_PERMISSION_STAFF_UPDATE,
        label: '역할 배정',
        hint: '다른 사람의 역할과 열람 범위를 바꾼다. **이 권한을 가진 사람은 누구에게든 어떤 역할이든 줄 수 있고, 자기 자신에게도 줄 수 있다.** 역할이 모든 권한의 출처이므로, 사실상 시스템 전체에 대한 권한이다. 역할의 내용을 바꾸는 것(이 화면)은 여기에 포함되지 않는다 — 그건 시스템관리자 속성이 필요하다.',
        sensitive: true,
      },
    ],
  },
]

/** Every permission name this screen knows how to label, in the order the screen shows them. */
export const LABELLED_PERMISSIONS: readonly string[] = PERMISSION_GROUPS.flatMap((group) =>
  group.permissions.map((permission) => permission.name),
)

export interface AttributeLabel {
  name: string
  label: string
  hint: string
  sensitive?: true
}

/**
 * The per-person attributes.
 *
 * Deliberately worded as "may be named as", not "can do". Nothing here opens a screen, and that is
 * the distinction the 사용자 관리 screen has to make legible: somebody can hold the PM role and not
 * the PM attribute, which means they do PM work but cannot be recorded as a project's 담당PM.
 */
export const ATTRIBUTE_LABELS: readonly AttributeLabel[] = [
  {
    name: NEOTMS_USER_ATTRIBUTE_SALES_MANAGER,
    label: '담당영업',
    hint: '프로젝트의 담당영업으로 지정될 수 있다. 프로젝트 폼의 담당영업 피커가 이 속성을 가진 사람만 보여 준다.',
  },
  {
    name: NEOTMS_USER_ATTRIBUTE_PM,
    label: '담당PM',
    hint: '프로젝트와 작업의 담당PM 으로 지정될 수 있다. 담당영업과 함께 가질 수 있다 — 두 역할을 겸하는 사람이 자기를 PM 으로 둔 프로젝트를 만드는 것은 정상이다.',
  },
  {
    name: NEOTMS_USER_ATTRIBUTE_SUPERUSER,
    label: '시스템관리자',
    hint: '**모든 권한 검사를 통과한다.** 역할에 무엇이 들어 있든 상관없이 모든 화면이 열리고, 역할 관리 화면(역할의 권한을 바꾸는 화면)에 들어갈 수 있는 것도 이 속성뿐이다. 역할 설정이 잘못되어 아무도 들어갈 수 없게 됐을 때의 복구 경로이기도 하다. 열람 범위는 넓히지 않는다 — 어느 행을 보는지는 별개의 설정이다.',
    sensitive: true,
  },
]

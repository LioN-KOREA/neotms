-- =====================================================================
-- 014_job_group.sql — 작업 그룹 코드 (2026-11-25, 팀장님 요청)
--
-- 작업 그룹 코드 = 알파벳 한 글자 + 회사 전체에서 이어지는 번호(6000부터). 예: J6000, N6001.
--   * 알파벳은 영업담당(SALES_MANAGER) 직원에게만 준다. 정해진 글자: 조선미 J, 유나경 N, 조수현 H,
--     이하경 L. 나머지 영업담당은 아직 안 쓴 글자를 차례로 자동 배정한다(처음 코드가 필요할 때).
--   * 작업을 만든 사람이 영업담당이면 그 글자, 아니면 그 프로젝트 영업담당의 글자, 그것도 없으면 'X'.
--   * 작업 등록 창 한 번에 만든 작업들(도착어마다 하나씩)은 같은 코드를 쓴다 — 앱이 처리.
--
-- 바뀌는 것: staff.job_group_letter, job.job_group, 시퀀스 job_group_seq, 함수 둘.
-- 기존 작업에는 id 순으로 하나씩 코드를 채운다(팀장님 결정 — 작업마다 따로). 다시 실행해도 안전하다.
-- =====================================================================

BEGIN;

ALTER TABLE staff ADD COLUMN IF NOT EXISTS job_group_letter text;
ALTER TABLE staff DROP CONSTRAINT IF EXISTS ck_staff_job_group_letter;
ALTER TABLE staff ADD CONSTRAINT ck_staff_job_group_letter CHECK (job_group_letter ~ '^[A-Z]$');
CREATE UNIQUE INDEX IF NOT EXISTS uq_staff_job_group_letter ON staff (job_group_letter) WHERE job_group_letter IS NOT NULL;
COMMENT ON COLUMN staff.job_group_letter IS
  'Letter of the job-group codes this person mints (J6000). Only sales managers get one; reserved by name: 조선미 J, 유나경 N, 조수현 H, 이하경 L; others get the first unused letter on first use.';

ALTER TABLE job ADD COLUMN IF NOT EXISTS job_group text;
CREATE INDEX IF NOT EXISTS ix_job_project_group ON job (project_id, job_group);
COMMENT ON COLUMN job.job_group IS
  'Job group code: letter + company-wide number from job_group_seq (J6000). Jobs created together from one job form share it; regrouped from the project page.';

CREATE SEQUENCE IF NOT EXISTS job_group_seq START WITH 6000 MINVALUE 6000;

-- 이 직원의 글자 (영업담당이면 없을 때 배정). 영업담당이 아니면 null.
CREATE OR REPLACE FUNCTION neotms_staff_group_letter(p_staff bigint) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE
  v_letter text;
  v_name   text;
  v_res    text[] := ARRAY['J','N','H','L'];
  v_pick   text;
BEGIN
  IF p_staff IS NULL THEN RETURN NULL; END IF;
  SELECT s.job_group_letter, s.mgr_name INTO v_letter, v_name FROM staff s WHERE s.id = p_staff;
  IF v_letter IS NOT NULL THEN RETURN v_letter; END IF;
  IF NOT EXISTS (SELECT 1 FROM staff_attribute a WHERE a.staff_id = p_staff AND a.attribute = 'NEOTMS_USER_ATTRIBUTE_SALES_MANAGER') THEN
    RETURN NULL;
  END IF;
  v_pick := CASE trim(v_name) WHEN '조선미' THEN 'J' WHEN '유나경' THEN 'N' WHEN '조수현' THEN 'H' WHEN '이하경' THEN 'L' END;
  IF v_pick IS NULL OR EXISTS (SELECT 1 FROM staff WHERE job_group_letter = v_pick) THEN
    SELECT l INTO v_pick
      FROM unnest(string_to_array('A,B,C,D,E,F,G,I,K,M,O,P,Q,R,S,T,U,V,W,Y,Z', ',')) AS l
     WHERE NOT EXISTS (SELECT 1 FROM staff WHERE job_group_letter = l)
     ORDER BY l LIMIT 1;
  END IF;
  IF v_pick IS NULL THEN RETURN NULL; END IF;  -- 글자가 다 찼다 → 'X' 로 떨어진다
  UPDATE staff SET job_group_letter = v_pick WHERE id = p_staff AND job_group_letter IS NULL;
  RETURN v_pick;
END $$;

-- 새 그룹 코드 하나 (번호를 하나 쓴다).
CREATE OR REPLACE FUNCTION neotms_next_job_group(p_staff bigint, p_project bigint) RETURNS text
LANGUAGE plpgsql AS $$
DECLARE v_letter text;
BEGIN
  v_letter := neotms_staff_group_letter(p_staff);
  IF v_letter IS NULL THEN
    v_letter := neotms_staff_group_letter((SELECT prj_mgr_id FROM project WHERE id = p_project));
  END IF;
  RETURN coalesce(v_letter, 'X') || nextval('job_group_seq')::text;
END $$;

-- 정해진 글자 먼저 (이름이 있는 영업담당).
UPDATE staff s SET job_group_letter = m.l
  FROM (VALUES ('조선미','J'), ('유나경','N'), ('조수현','H'), ('이하경','L')) AS m(n, l)
 WHERE trim(s.mgr_name) = m.n AND s.job_group_letter IS NULL
   AND NOT EXISTS (SELECT 1 FROM staff o WHERE o.job_group_letter = m.l);

-- 기존 작업: id 순으로 하나씩 (작업을 만든 사람은 기록에 아이디 글자로만 남아 있어, 프로젝트 영업담당 기준).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT id, project_id FROM job WHERE job_group IS NULL ORDER BY id LOOP
    UPDATE job SET job_group = neotms_next_job_group(NULL, r.project_id) WHERE id = r.id;
  END LOOP;
END $$;

COMMIT;

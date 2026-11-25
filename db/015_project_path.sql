-- 015: 프로젝트 NAS 경로와 인계 경로 (팀장님 2026-11-25).
--
-- project.prj_path  : 프로젝트 등록·수정 창의 '경로' (NAS 경로를 붙여 넣는 칸). 상세 화면에 보인다.
-- job_handover.path : 인계 창의 '경로' — 기본은 프로젝트 경로, 인계마다 고칠 수 있다(프로젝트 경로는 그대로).
--                     인계를 받으면(재인계 확인 포함) 받은 사람 '나의 업무' 시트의 경로 열로 들어간다.
--
-- 다시 실행해도 된다.

ALTER TABLE project      ADD COLUMN IF NOT EXISTS prj_path text;
ALTER TABLE job_handover ADD COLUMN IF NOT EXISTS path     text;

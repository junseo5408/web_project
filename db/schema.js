/**
 * MySQL 스키마 정의 (DR-01, DR-02, DR-03, DR-06)
 * 관계와 일관성이 중요한 데이터(계정, 권한, 구성원, Crew 소속, 업무-참여자, 자원-배정)를 저장한다.
 * 서버 시작 시 CREATE TABLE IF NOT EXISTS 로 자동 생성된다.
 */
module.exports = [
  `CREATE TABLE IF NOT EXISTS roles (
    id TINYINT UNSIGNED PRIMARY KEY,
    code VARCHAR(20) NOT NULL UNIQUE,
    name VARCHAR(50) NOT NULL,
    level TINYINT UNSIGNED NOT NULL UNIQUE,
    description VARCHAR(255)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS permissions (
    code VARCHAR(50) PRIMARY KEY,
    category VARCHAR(30) NOT NULL,
    description VARCHAR(255) NOT NULL
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS role_permissions (
    role_id TINYINT UNSIGNED NOT NULL,
    permission_code VARCHAR(50) NOT NULL,
    PRIMARY KEY (role_id, permission_code),
    FOREIGN KEY (role_id) REFERENCES roles(id),
    FOREIGN KEY (permission_code) REFERENCES permissions(code) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS regions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    description VARCHAR(255),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS members (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username VARCHAR(30) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL,
    name VARCHAR(50) NOT NULL,
    alias VARCHAR(50),
    email VARCHAR(100) UNIQUE,
    phone VARCHAR(30),
    birth_date DATE,
    role_id TINYINT UNSIGNED NOT NULL,
    status ENUM('PENDING','ACTIVE','STANDBY','SUSPENDED','WITHDRAWN') NOT NULL DEFAULT 'PENDING',
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    notes TEXT,
    is_locked TINYINT(1) NOT NULL DEFAULT 0,
    locked_reason VARCHAR(255),
    token_version INT UNSIGNED NOT NULL DEFAULT 0,
    failed_logins INT UNSIGNED NOT NULL DEFAULT 0,
    last_login_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (role_id) REFERENCES roles(id),
    INDEX idx_members_status (status),
    INDEX idx_members_role (role_id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS crews (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(50) NOT NULL UNIQUE,
    region_id INT UNSIGNED,
    description VARCHAR(255),
    capo_id INT UNSIGNED,
    underboss_id INT UNSIGNED,
    status ENUM('ACTIVE','DISSOLVED') NOT NULL DEFAULT 'ACTIVE',
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (region_id) REFERENCES regions(id),
    FOREIGN KEY (capo_id) REFERENCES members(id),
    FOREIGN KEY (underboss_id) REFERENCES members(id)
  ) ENGINE=InnoDB`,

  // BR-01: active_formal_key 에 UNIQUE 제약 -> 한 구성원은 동시에 하나의 Crew에만 정식(FORMAL) 소속 가능
  `CREATE TABLE IF NOT EXISTS crew_memberships (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    crew_id INT UNSIGNED NOT NULL,
    member_id INT UNSIGNED NOT NULL,
    membership_type ENUM('FORMAL','AFFILIATE') NOT NULL DEFAULT 'FORMAL',
    joined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    left_at DATETIME,
    left_reason VARCHAR(255),
    changed_by INT UNSIGNED,
    active_formal_key INT UNSIGNED GENERATED ALWAYS AS
      (IF(left_at IS NULL AND membership_type = 'FORMAL', member_id, NULL)) STORED,
    active_pair_key VARCHAR(40) GENERATED ALWAYS AS
      (IF(left_at IS NULL, CONCAT(crew_id, ':', member_id), NULL)) STORED,
    UNIQUE KEY uq_one_formal_crew (active_formal_key),
    UNIQUE KEY uq_active_pair (active_pair_key),
    FOREIGN KEY (crew_id) REFERENCES crews(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    INDEX idx_cm_member (member_id, left_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS member_skills (
    member_id INT UNSIGNED NOT NULL,
    skill VARCHAR(50) NOT NULL,
    level TINYINT UNSIGNED NOT NULL DEFAULT 1,
    PRIMARY KEY (member_id, skill),
    FOREIGN KEY (member_id) REFERENCES members(id) ON DELETE CASCADE
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS promotion_requests (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    member_id INT UNSIGNED NOT NULL,
    current_role_id TINYINT UNSIGNED NOT NULL,
    target_role_id TINYINT UNSIGNED NOT NULL,
    requested_by INT UNSIGNED NOT NULL,
    reason VARCHAR(500),
    status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    reviewed_by INT UNSIGNED,
    review_comment VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (target_role_id) REFERENCES roles(id),
    FOREIGN KEY (requested_by) REFERENCES members(id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS crew_join_requests (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    crew_id INT UNSIGNED NOT NULL,
    member_id INT UNSIGNED NOT NULL,
    membership_type ENUM('FORMAL','AFFILIATE') NOT NULL DEFAULT 'FORMAL',
    message VARCHAR(500),
    status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    reviewed_by INT UNSIGNED,
    review_comment VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    FOREIGN KEY (crew_id) REFERENCES crews(id),
    FOREIGN KEY (member_id) REFERENCES members(id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS disciplinary_actions (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    member_id INT UNSIGNED NOT NULL,
    action_type ENUM('WARNING','SUSPENSION') NOT NULL,
    reason VARCHAR(500) NOT NULL,
    issued_by INT UNSIGNED NOT NULL,
    status ENUM('ACTIVE','REVOKED') NOT NULL DEFAULT 'ACTIVE',
    revoked_by INT UNSIGNED,
    revoke_reason VARCHAR(500),
    revoked_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (member_id) REFERENCES members(id),
    FOREIGN KEY (issued_by) REFERENCES members(id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS tasks (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    description TEXT,
    crew_id INT UNSIGNED NOT NULL,
    priority ENUM('LOW','NORMAL','HIGH','CRITICAL') NOT NULL DEFAULT 'NORMAL',
    status ENUM('PLANNED','IN_PROGRESS','ON_HOLD','COMPLETED','CANCELLED') NOT NULL DEFAULT 'PLANNED',
    start_at DATETIME NOT NULL,
    end_at DATETIME NOT NULL,
    location VARCHAR(100),
    allow_concurrent TINYINT(1) NOT NULL DEFAULT 0,
    required_skills JSON,
    result_outcome ENUM('SUCCESS','PARTIAL','FAILURE'),
    result_summary TEXT,
    result_value DECIMAL(14,2),
    completed_at DATETIME,
    completed_by INT UNSIGNED,
    created_by INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CHECK (end_at > start_at),
    FOREIGN KEY (crew_id) REFERENCES crews(id),
    FOREIGN KEY (created_by) REFERENCES members(id),
    INDEX idx_tasks_crew_status (crew_id, status),
    INDEX idx_tasks_period (start_at, end_at)
  ) ENGINE=InnoDB`,

  // DR-02: 업무-참여 구성원 N:M 관계
  `CREATE TABLE IF NOT EXISTS task_assignments (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    task_id INT UNSIGNED NOT NULL,
    member_id INT UNSIGNED NOT NULL,
    task_role VARCHAR(50),
    instructions TEXT,
    status ENUM('ASSIGNED','ACCEPTED','DECLINED','REMOVED') NOT NULL DEFAULT 'ASSIGNED',
    assigned_by INT UNSIGNED NOT NULL,
    assigned_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    responded_at DATETIME,
    removed_at DATETIME,
    attendance ENUM('PRESENT','PARTIAL','ABSENT'),
    contribution TINYINT UNSIGNED,
    participation_note VARCHAR(500),
    active_key VARCHAR(40) GENERATED ALWAYS AS
      (IF(status IN ('ASSIGNED','ACCEPTED'), CONCAT(task_id, ':', member_id), NULL)) STORED,
    UNIQUE KEY uq_active_assignment (active_key),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    INDEX idx_ta_member (member_id, status)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS resource_types (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(30) NOT NULL UNIQUE,
    name VARCHAR(50) NOT NULL,
    description VARCHAR(255),
    default_min_level TINYINT UNSIGNED NOT NULL DEFAULT 2
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS resources (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    code VARCHAR(30) NOT NULL UNIQUE,
    name VARCHAR(100) NOT NULL,
    type_id INT UNSIGNED NOT NULL,
    crew_id INT UNSIGNED,
    status ENUM('AVAILABLE','IN_USE','NEEDS_INSPECTION','MAINTENANCE','UNAVAILABLE','RETIRED') NOT NULL DEFAULT 'AVAILABLE',
    location VARCHAR(100),
    min_role_level TINYINT UNSIGNED NOT NULL DEFAULT 2,
    description VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (type_id) REFERENCES resource_types(id),
    FOREIGN KEY (crew_id) REFERENCES crews(id),
    INDEX idx_resources_status (status)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS resource_allocations (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    resource_id INT UNSIGNED NOT NULL,
    task_id INT UNSIGNED,
    member_id INT UNSIGNED,
    start_at DATETIME NOT NULL,
    end_at DATETIME NOT NULL,
    status ENUM('RESERVED','IN_USE','RETURNED','CANCELLED') NOT NULL DEFAULT 'RESERVED',
    purpose VARCHAR(255),
    allocated_by INT UNSIGNED NOT NULL,
    checked_out_at DATETIME,
    returned_at DATETIME,
    return_condition ENUM('GOOD','DAMAGED','LOST'),
    return_note VARCHAR(500),
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (end_at > start_at),
    CHECK (task_id IS NOT NULL OR member_id IS NOT NULL),
    FOREIGN KEY (resource_id) REFERENCES resources(id),
    FOREIGN KEY (task_id) REFERENCES tasks(id),
    FOREIGN KEY (member_id) REFERENCES members(id),
    INDEX idx_alloc_resource (resource_id, status, start_at, end_at)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS resource_requests (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    resource_id INT UNSIGNED NOT NULL,
    requester_id INT UNSIGNED NOT NULL,
    task_id INT UNSIGNED,
    start_at DATETIME NOT NULL,
    end_at DATETIME NOT NULL,
    purpose VARCHAR(255),
    status ENUM('PENDING','APPROVED','REJECTED','CANCELLED') NOT NULL DEFAULT 'PENDING',
    reviewed_by INT UNSIGNED,
    review_comment VARCHAR(500),
    allocation_id INT UNSIGNED,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    reviewed_at DATETIME,
    FOREIGN KEY (resource_id) REFERENCES resources(id),
    FOREIGN KEY (requester_id) REFERENCES members(id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS resource_issues (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    resource_id INT UNSIGNED NOT NULL,
    reported_by INT UNSIGNED NOT NULL,
    severity ENUM('LOW','MEDIUM','HIGH') NOT NULL DEFAULT 'MEDIUM',
    description VARCHAR(500) NOT NULL,
    status ENUM('OPEN','RESOLVED') NOT NULL DEFAULT 'OPEN',
    resolved_by INT UNSIGNED,
    resolution VARCHAR(500),
    resolved_at DATETIME,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES resources(id),
    FOREIGN KEY (reported_by) REFERENCES members(id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS meetings (
    id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    title VARCHAR(100) NOT NULL,
    agenda TEXT,
    crew_id INT UNSIGNED,
    location VARCHAR(100),
    start_at DATETIME NOT NULL,
    end_at DATETIME NOT NULL,
    status ENUM('SCHEDULED','CANCELLED','DONE') NOT NULL DEFAULT 'SCHEDULED',
    organizer_id INT UNSIGNED NOT NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (end_at > start_at),
    FOREIGN KEY (crew_id) REFERENCES crews(id),
    FOREIGN KEY (organizer_id) REFERENCES members(id)
  ) ENGINE=InnoDB`,

  `CREATE TABLE IF NOT EXISTS meeting_attendees (
    meeting_id INT UNSIGNED NOT NULL,
    member_id INT UNSIGNED NOT NULL,
    rsvp ENUM('PENDING','YES','NO','MAYBE') NOT NULL DEFAULT 'PENDING',
    responded_at DATETIME,
    PRIMARY KEY (meeting_id, member_id),
    FOREIGN KEY (meeting_id) REFERENCES meetings(id) ON DELETE CASCADE,
    FOREIGN KEY (member_id) REFERENCES members(id)
  ) ENGINE=InnoDB`,
];

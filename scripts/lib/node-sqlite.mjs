/**
 * 冒烟脚本共用的基建：`expo-sqlite` → `node:sqlite` 适配层 + 场景上下文。
 *
 * 抽出来的原因：迁移冒烟（`db-migrate-smoke.mjs`）与通知冒烟
 * （`notifications-smoke.mjs`）需要**同一套**「用真机同一份源码跑真 SQLite」
 * 的能力，各写一份就迟早漂移（比如一边补了 trace、另一边没有）。
 *
 * 零额外依赖：只用 Node 内置的 `node:sqlite`，不需要 Expo / 模拟器 / 网络。
 * 前置条件：Node >= 22.18（`node:sqlite` 可用 + 默认开启 TS 类型擦除）。
 */
import { existsSync, rmSync } from 'node:fs';

// node:sqlite 是唯一的前置条件，早失败早提示，别让它在某次 runAsync 里
// 才以「node:sqlite 不可用」的形式冒出来。
let DatabaseSync;
try {
  ({ DatabaseSync } = await import('node:sqlite'));
} catch (error) {
  console.error(
    '[FAIL] 无法加载 Node 内置模块 node:sqlite。\n' +
      '  冒烟测试需要 Node >= 22.18（node:sqlite 可用 + 默认开启 TS 类型擦除），\n' +
      `  当前版本：${process.version}\n  原始错误：${error.message}`,
  );
  process.exit(1);
}

/**
 * 只实现迁移/仓库链路真正用到的方法，签名与 expo-sqlite 的 `SQLiteDatabase` 对齐。
 * 每条语句都记进 trace，失败时能原样把 SQL 打出来。
 */
export class NodeSqliteAdapter {
  /**
   * @param {string} file 数据库文件路径
   * @param {Array<object>} trace 跨多次 open 共享的 SQL 轨迹
   */
  constructor(file, trace) {
    this.file = file;
    this.trace = trace;
    this.raw = new DatabaseSync(file);
  }

  /** 统一入口：先记录这条 SQL，再执行，失败时把错误挂回这条记录 */
  async #execute(op, sql, action) {
    const entry = { index: this.trace.length + 1, op, sql };
    this.trace.push(entry);
    try {
      return await action();
    } catch (error) {
      entry.error = error instanceof Error ? error : new Error(String(error));
      throw entry.error;
    }
  }

  execAsync(sql) {
    return this.#execute('execAsync', sql, () => this.raw.exec(sql));
  }

  runAsync(sql, params = []) {
    return this.#execute('runAsync', sql, () => {
      const info = this.raw.prepare(sql).run(...params);
      return { lastInsertRowId: Number(info.lastInsertRowid), changes: Number(info.changes) };
    });
  }

  getFirstAsync(sql, params = []) {
    return this.#execute('getFirstAsync', sql, () => this.raw.prepare(sql).get(...params) ?? null);
  }

  getAllAsync(sql, params = []) {
    return this.#execute('getAllAsync', sql, () => this.raw.prepare(sql).all(...params));
  }

  /**
   * expo-sqlite 的 withTransactionAsync。
   * 内部再抛任何错都会 ROLLBACK —— 这正是 DDL 一起消失、表看起来「不存在」的原因。
   */
  async withTransactionAsync(fn) {
    this.trace.push({
      index: this.trace.length + 1,
      op: 'transaction',
      sql: 'BEGIN ... COMMIT / ROLLBACK',
    });
    this.raw.exec('BEGIN');
    try {
      const result = await fn();
      this.raw.exec('COMMIT');
      return result;
    } catch (error) {
      this.raw.exec('ROLLBACK');
      throw error;
    }
  }

  /** 布置场景用：执行原始 SQL（会进 trace，方便失败时看到现场） */
  arrange(sql) {
    return this.#execute('arrange', sql, () => this.raw.exec(sql));
  }

  /** 断言用：直接读，不进 trace，避免污染轨迹 */
  probe(sql) {
    return this.raw.prepare(sql).all();
  }

  close() {
    this.raw.close();
  }
}

/** 一个场景的数据库生命周期（可能被删库重建多次 open） */
export class ScenarioContext {
  constructor(file) {
    this.file = file;
    this.trace = [];
    this.adapter = null;
  }

  open() {
    this.adapter = new NodeSqliteAdapter(this.file, this.trace);
    return this.adapter;
  }

  get db() {
    if (!this.adapter) throw new Error('场景自身有问题：请先调用 ctx.open()');
    return this.adapter;
  }

  /** 删库重建：关连接 → 删 .db / -wal / -shm → 重新打开 */
  resetStorage() {
    this.adapter?.close();
    deleteDatabaseFiles(this.file);
    return this.open();
  }

  close() {
    this.adapter?.close();
    this.adapter = null;
  }
}

export function deleteDatabaseFiles(file) {
  for (const suffix of ['', '-wal', '-shm']) {
    const target = `${file}${suffix}`;
    if (existsSync(target)) rmSync(target, { force: true });
  }
}

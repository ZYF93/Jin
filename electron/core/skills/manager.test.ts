import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { SkillManager } from "./manager";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "jin-skills-"));
  roots.push(root);
  return root;
}

function writeSkill(
  skillsRoot: string,
  directory: string,
  name: string,
  description: string,
): string {
  const target = join(skillsRoot, directory);
  mkdirSync(target, { recursive: true });
  writeFileSync(
    join(target, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\nBody for ${name}.\n`,
    "utf8",
  );
  return target;
}

describe("SkillManager", () => {
  it("scans project and every configured user skill root", () => {
    const project = tempRoot();
    const jin = tempRoot();
    const agents = tempRoot();
    const ccSwitch = tempRoot();
    writeSkill(join(project, ".jin", "skills"), "project-skill", "project-skill", "Project");
    writeSkill(jin, "jin-skill", "jin-skill", "Jin user root");
    writeSkill(agents, "agent-skill", "agent-skill", "Agents user root");
    writeSkill(ccSwitch, "switch-skill", "switch-skill", "cc-switch user root");

    const manager = new SkillManager(project, [jin, agents, ccSwitch]);
    const skills = manager.list();

    expect(skills.map((skill) => skill.name)).toEqual([
      "agent-skill",
      "jin-skill",
      "project-skill",
      "switch-skill",
    ]);
    expect(
      skills.map((skill) => `${skill.name}:${skill.scope}`),
    ).toEqual([
      "agent-skill:user",
      "jin-skill:user",
      "project-skill:project",
      "switch-skill:user",
    ]);
  });

  it("lets project skills win name collisions and prefers earlier user roots", () => {
    const project = tempRoot();
    const first = tempRoot();
    const second = tempRoot();
    writeSkill(join(project, ".jin", "skills"), "shared-project", "shared", "From project");
    writeSkill(first, "shared-first", "shared-user", "From first user root");
    writeSkill(second, "shared-second", "shared-user", "From second user root");

    const manager = new SkillManager(project, [first, second]);
    const byName = new Map(manager.list().map((skill) => [skill.name, skill]));

    expect(manager.list()).toHaveLength(2);
    expect(byName.get("shared")?.description).toBe("From project");
    expect(byName.get("shared-user")?.description).toBe("From first user root");
  });

  it("deduplicates repeated roots and resolves skills by directory name", () => {
    const project = tempRoot();
    const user = tempRoot();
    writeSkill(user, "pdf-tools", "PDF Toolkit", "Work with PDFs");

    const manager = new SkillManager(project, [user, user]);
    expect(manager.list()).toHaveLength(1);
    expect(manager.read("pdf-tools")?.info.name).toBe("PDF Toolkit");
    expect(manager.read("PDF TOOLKIT")?.info.description).toBe("Work with PDFs");
  });

  it("ignores missing roots and malformed skill directories", () => {
    const project = tempRoot();
    const user = tempRoot();
    mkdirSync(join(user, "empty-directory"), { recursive: true });
    writeSkill(user, "valid", "valid", "Valid skill");

    const manager = new SkillManager(project, [join(user, "does-not-exist"), user]);
    expect(manager.list().map((skill) => skill.name)).toEqual(["valid"]);
  });
});

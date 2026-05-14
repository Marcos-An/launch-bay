export type HermesSkillListEntry = {
  name: string;
  description: string;
};

const TABLE_BORDER_CHARS = /^[┏┓┗┛┣┫┳┻╋┡┩┯┷┿┌┐└┘├┤┬┴┼─━╇╈╍╏╞╡╪╫╭╮╰╯]+$/;

export function parseHermesSkillsList(stdout: string): HermesSkillListEntry[] {
  const skills: HermesSkillListEntry[] = [];
  const seen = new Set<string>();

  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    if (TABLE_BORDER_CHARS.test(trimmed)) continue;
    if (!/[│┃]/.test(trimmed)) continue;

    const cells = trimmed.split(/[│┃]/).map((cell) => cell.trim());
    if (cells[0] === '') cells.shift();
    if (cells.at(-1) === '') cells.pop();

    if (cells.length < 1) continue;
    const [name, category] = cells;
    if (!name || name === 'Name' || name.includes('…') || seen.has(name)) continue;

    seen.add(name);
    skills.push({
      name,
      description: category && category !== 'Category' ? `${category} · skill` : 'skill'
    });

    if (skills.length >= 200) break;
  }

  return skills;
}

// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { parseHermesSkillsList } from './hermesSkills.js';

describe('parseHermesSkillsList', () => {
  it('parses Hermes rich table output into slash-suggestion skills', () => {
    const stdout = `Installed Skills (enabled only)
┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━━━━━━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┳━━━━━━━━━┓
┃ Name                                              ┃ Category             ┃ Source  ┃ Trust   ┃ Status  ┃
┡━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━━━━━━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━╇━━━━━━━━━┩
│ dogfood                                           │                      │ builtin │ builtin │ enabled │
│ obsidian                                          │ note-taking          │ builtin │ builtin │ enabled │
│ engineering-contract-coding                       │ software-development │ local   │ local   │ enabled │
└───────────────────────────────────────────────────┴──────────────────────┴─────────┴─────────┴─────────┘
`;

    expect(parseHermesSkillsList(stdout)).toEqual([
      { name: 'dogfood', description: 'skill' },
      { name: 'obsidian', description: 'note-taking · skill' },
      { name: 'engineering-contract-coding', description: 'software-development · skill' }
    ]);
  });

  it('skips truncated names so the picker does not suggest invalid slash commands', () => {
    const stdout = `│ macos-local-first-swif… │ apple │ local │ local │ enabled │
│ hermes-agent            │ autonomous-ai-agents │ builtin │ builtin │ enabled │`;

    expect(parseHermesSkillsList(stdout)).toEqual([
      { name: 'hermes-agent', description: 'autonomous-ai-agents · skill' }
    ]);
  });
});

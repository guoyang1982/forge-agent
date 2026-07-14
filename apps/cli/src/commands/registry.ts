import type { CommandContext, SlashCommand } from "./types.js";

export class SlashCommandRegistry {
  private commands = new Map<string, SlashCommand>();

  register(command: SlashCommand): void {
    this.commands.set(command.name.toLowerCase(), command);
    for (const alias of command.aliases ?? []) {
      this.commands.set(alias.toLowerCase(), command);
    }
  }

  registerMany(commands: SlashCommand[]): void {
    for (const command of commands) this.register(command);
  }

  async dispatch(input: string, ctx: CommandContext): Promise<boolean> {
    const [rawCmd, ...rest] = input.slice(1).split(/\s+/);
    const cmd = rawCmd.toLowerCase();
    const args = rest.join(" ").trim();
    const command = this.commands.get(cmd);

    if (!command) {
      ctx.printUnknownSlash(rawCmd);
      return true;
    }

    await command.run(ctx, args);
    return true;
  }
}

export function createCommandRegistry(): SlashCommandRegistry {
  return new SlashCommandRegistry();
}

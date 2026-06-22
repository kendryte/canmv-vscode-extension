export interface ToolPanelLike {
  readonly disposed: boolean;
  reveal(): void;
  dispose(): void;
}

export interface ToolDescriptor {
  id: string;
  name: string;
  icon: string;
  factory: () => ToolPanelLike;
  visible?: boolean;  // default true — false hides from Toolbox
}

export class ToolRegistry {
  private tools = new Map<string, ToolDescriptor>();

  register(desc: ToolDescriptor): void { this.tools.set(desc.id, desc); }

  get(id: string): ToolDescriptor | undefined { return this.tools.get(id); }

  list(): ToolDescriptor[] { return [...this.tools.values()]; }

  listVisible(): ToolDescriptor[] { return this.list().filter(t => t.visible !== false); }
}

export class ToolHost {
  private panels = new Map<string, ToolPanelLike>();

  constructor(private registry: ToolRegistry) {}

  open(id: string): ToolPanelLike {
    const existing = this.panels.get(id);
    if (existing && !existing.disposed) {
      existing.reveal();
      return existing;
    }
    if (existing) {
      // Dispose of stale reference before creating a new one
      this.panels.delete(id);
    }
    const desc = this.registry.get(id);
    if (!desc) {
      throw new Error(`Tool not found: ${id}`);
    }
    const panel = desc.factory();
    this.panels.set(id, panel);
    return panel;
  }

  close(id: string): void {
    const panel = this.panels.get(id);
    if (panel) {
      panel.dispose();
      this.panels.delete(id);
    }
  }

  closeAll(): void {
    for (const [id, panel] of this.panels) {
      panel.dispose();
    }
    this.panels.clear();
  }
}

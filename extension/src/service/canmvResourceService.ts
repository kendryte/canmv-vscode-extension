import { logWarn } from '../output';
import { CanmvResourceRouteService } from './resourceRouteService';
import { ExamplesService } from './examplesService';
import { StubsService } from './stubsService';

export class CanmvResourceService {
  constructor(
    private readonly routeService: CanmvResourceRouteService,
    private readonly stubsService: StubsService,
    private readonly examplesService: ExamplesService,
  ) {}

  async ensureDefaultResources(): Promise<string | null> {
    const route = await this.routeService.resolve('');
    if (route) {
      await this.examplesService.ensureExamples(route);
      return this.stubsService.ensureRouteStubs(route, 'default');
    }

    logWarn('Resources', 'Failed to resolve latest CanMV resources; using local cached resources');
    await this.examplesService.ensureExamples(null);
    return this.stubsService.ensureDefaultStubs();
  }

  async ensureDefaultExamples(): Promise<string | null> {
    const route = await this.routeService.resolve('');
    return this.examplesService.ensureExamples(route);
  }

  async ensureBoardResources(boardRevision: string): Promise<string | null> {
    const route = await this.routeService.resolve(boardRevision);
    if (!route) {
      await this.examplesService.ensureExamples(null);
      const stubsPath = await this.stubsService.downloadStubs(boardRevision);
      return stubsPath;
    }

    await this.examplesService.ensureExamples(route);
    return this.stubsService.ensureRouteStubs(route, 'board');
  }
}

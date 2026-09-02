import { Controller, Get } from '@nestjs/common';
import {
  ApiOkResponse,
  ApiOperation,
  ApiProperty,
  ApiTags,
} from '@nestjs/swagger';

class HealthResponse {
  @ApiProperty({ example: 'ok' })
  status!: 'ok';

  @ApiProperty({ example: 'kaapy' })
  service!: string;

  @ApiProperty({ example: '2026-09-02T12:00:00.000Z' })
  timestamp!: string;
}

@ApiTags('health')
@Controller('health')
export class HealthController {
  @Get()
  @ApiOperation({ summary: 'Check whether the API is running' })
  @ApiOkResponse({ type: HealthResponse })
  getHealth(): HealthResponse {
    return {
      status: 'ok',
      service: 'kaapy',
      timestamp: new Date().toISOString(),
    };
  }
}

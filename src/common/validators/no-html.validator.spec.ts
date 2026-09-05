import { validate } from 'class-validator';
import { NoHtml } from './no-html.validator.js';

class PlainTextDto {
  @NoHtml()
  value!: unknown;
}

async function validateValue(value: unknown) {
  const dto = new PlainTextDto();
  dto.value = value;
  return validate(dto);
}

describe('NoHtml', () => {
  it.each(['Hello World', 'John Doe', 'Normal text 123', 'john@example.com'])(
    'accepts plain text: %s',
    async (value) => {
      expect(await validateValue(value)).toHaveLength(0);
    },
  );

  it.each([
    '<script>alert(1)</script>',
    '<h1>Hello</h1>',
    '<b>bold</b>',
    '<img src=x>',
    '<div class="test">hello</div>',
    '<DIV>Hello</DIV>',
    '<br/>',
  ])('rejects HTML markup: %s', async (value) => {
    expect(await validateValue(value)).toHaveLength(1);
  });

  it.each([undefined, null, ''])(
    'does not throw for safe edge value: %s',
    async (value) => {
      await expect(validateValue(value)).resolves.toBeDefined();
    },
  );

  it('does not reject non-string values', async () => {
    expect(await validateValue(42)).toHaveLength(0);
  });
});
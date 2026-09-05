import {
  registerDecorator,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';

const htmlTagPattern = /<\/?[a-z][^>]*>/i;

export function NoHtml(validationOptions?: ValidationOptions): PropertyDecorator {
  return (target: object, propertyKey: string | symbol) => {
    registerDecorator({
      name: 'noHtml',
      target: target.constructor,
      propertyName: propertyKey.toString(),
      options: validationOptions,
      validator: {
        validate(value: unknown, _args: ValidationArguments): boolean {
          return typeof value !== 'string' || !htmlTagPattern.test(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} must not contain HTML markup`;
        },
      },
    });
  };
}
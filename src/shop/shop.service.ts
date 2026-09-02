import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Shop, ShopDocument } from './schemas/shop.schema.js';

@Injectable()
export class ShopService {
  constructor(
    @InjectModel(Shop.name) private readonly shopModel: Model<ShopDocument>,
  ) {}

  findAll(): Promise<ShopDocument[]> {
    return this.shopModel.find().sort({ createdAt: -1 }).exec();
  }

  async findOne(id: string): Promise<ShopDocument> {
    const shop = await this.shopModel.findById(id).exec();

    if (!shop) {
      throw new NotFoundException(`Shop ${id} was not found`);
    }

    return shop;
  }
}
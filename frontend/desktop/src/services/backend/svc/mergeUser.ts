import { MergeUserEvent } from '@/types/db/event';
import { USER_MERGE_STATUS } from '@/types/response/merge';
import { NextApiResponse } from 'next';
import { TransactionStatus, TransactionType, UserStatus } from 'prisma/global/generated/client';
import { v4 } from 'uuid';
import { globalPrisma } from '../db/init';
import { jsonRes } from '../response';

export const mergeUserSvc =
  (userUid: string, mergeUserUid: string) => async (res: NextApiResponse) => {
    const user = await globalPrisma.user.findUnique({
      where: {
        status: UserStatus.NORMAL_USER,
        uid: userUid
      },
      include: {
        oauthProvider: true
      }
    });
    if (!user)
      return jsonRes(res, {
        message: USER_MERGE_STATUS.USER_NOT_FOUND,
        code: 404
      });
    const txUid = v4();
    const infoUid = v4();
    const regionResults = await globalPrisma.region.findMany();
    if (!regionResults) throw Error('region list is null');
    const regionList = regionResults.map((r) => r.uid);
    const oauthProviderList = await globalPrisma.oauthProvider.findMany({
      where: {
        userUid: mergeUserUid
      }
    });
    // add task ( catch by outer )
    await globalPrisma.$transaction(async (tx) => {
      // optimistic
      for await (const oauthProvider of oauthProviderList) {
        await tx.oauthProvider.findUniqueOrThrow({
          where: {
            uid: oauthProvider.uid,
            userUid: mergeUserUid
          }
        });
        await tx.oauthProvider.update({
          where: {
            uid: oauthProvider.uid,
            userUid: mergeUserUid
          },
          data: {
            userUid
          }
        });
        const eventName = MergeUserEvent['<MERGE_USER>_MERGE_OAUTH_PROVIDER'];
        const _data = {
          mergeUserUid,
          userUid,
          providerType: oauthProvider.providerType,
          providerId: oauthProvider.providerId,
          message: `${oauthProvider.providerType}: ${oauthProvider.providerId}, update`
        };
        await tx.eventLog.create({
          data: {
            eventName,
            mainId: userUid,
            data: JSON.stringify(_data)
          }
        });
      }
      await tx.user.update({
        where: { uid: mergeUserUid },
        data: {
          status: UserStatus.DELETE_USER
        }
      });
      // Log the delete event
      await tx.eventLog.create({
        data: {
          eventName: MergeUserEvent['<MERGE_USER>_SET_DELETE_USER'],
          mainId: userUid,
          data: JSON.stringify({
            mergeUserUid,
            message: 'Delete merge process'
          })
        }
      });
      await tx.precommitTransaction.create({
        data: {
          uid: txUid,
          status: TransactionStatus.READY,
          infoUid,
          transactionType: TransactionType.MERGE_USER
        }
      });
      await tx.eventLog.create({
        data: {
          eventName: MergeUserEvent['<MERGE_USER>_PUB_TRANSACTION'],
          mainId: userUid,
          data: JSON.stringify({
            message: `${userUid} publish merge user transaction`
          })
        }
      });
      await tx.mergeUserTransactionInfo.create({
        data: {
          uid: infoUid,
          mergeUserUid,
          userUid
        }
      });
      await tx.transactionDetail.createMany({
        data: regionList.map((regionUid) => ({
          status: TransactionStatus.READY,
          transactionUid: txUid,
          regionUid
        }))
      });
    });
    return jsonRes(res, {
      message: USER_MERGE_STATUS.RESULT_SUCCESS,
      code: 200
    });
  };
